import type { Context } from "hono";
import type { AppEnv } from "../types/env.js";
import type { Provider } from "../types/config.js";
import { getModelId, getModelPricing } from "../types/config.js";
import { getConfig } from "../config.js";
import { nanoid } from "nanoid";
import { writeLog } from "../store/log-writer.js";
import { recordRequest } from "../metrics/collector.js";
import { extractTags } from "../tags/registry.js";
import { createGunzip, createInflate, createBrotliDecompress, createZstdDecompress } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import {
  needsResponsesBridge,
  responsesRequestToChat,
  chatResponseToResponses,
  ChatToResponsesSseTransform,
} from "./bridge/responses-chat-bridge.js";

// Shared keepAlive agents for connection pooling. Without these, every
// outgoing request opens a new TCP connection, causing TIME_WAIT
// accumulation and ephemeral port exhaustion under sustained load.
const httpAgent = new HttpAgent({ keepAlive: true, maxFreeSockets: 20, keepAliveMsecs: 30_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxFreeSockets: 20, keepAliveMsecs: 30_000 });

export type RouteTraceEntry = {
  provider: string;
  status: number | null;
  latencyMs: number;
  reason?: string;
  // Raw upstream error body when this attempt failed (non-2xx response).
  // Lets the dashboard surface the provider's real error message, and
  // lets the final-fail response echo it verbatim to the client.
  errorBody?: unknown;
};

// Optional routing metadata passed when the request used a model alias.
// aliasName is the alias the user requested (used for logging); realModelIds
// maps each provider to the real model ID it should receive in body.model.
export interface ForwardOptions {
  aliasName?: string;
  realModelIds?: Map<string, string>;
}

// Outcome of one upstream attempt. Two states:
//   success — we have a Response ready to hand to the client.
//   fail    — the attempt did not produce a usable response; carry the
//             upstream status + raw body so the forwarder can either
//             continue to the next candidate or, if this was the last,
//             echo it back to the client verbatim.
// Thrown network errors / timeouts / client aborts are also `fail`
// with status=502 and a synthetic error body.
type AttemptResult =
  | { kind: "success"; response: Response; ttftMs: number }
  | { kind: "fail"; status: number; body: unknown; ttftMs: number };

const roundRobinCounters = new Map<string, number>();

function selectApiKey(provider: Provider): { key: string; index: number } {
  const keys = Array.isArray(provider.apiKey) ? provider.apiKey : [provider.apiKey];
  if (keys.length === 1) return { key: keys[0], index: 0 };
  const counter = (roundRobinCounters.get(provider.id) ?? -1) + 1;
  const index = counter % keys.length;
  roundRobinCounters.set(provider.id, counter);
  return { key: keys[index], index };
}

// Build the post URL for the given provider+path and a sensible choice
// for the upstream auth/transport headers. Stays identical for the
// same entry protocol as the provider's type — there is no longer any
// cross-protocol routing.
function buildTargetHeaders(
  provider: Provider,
  selectedKey: string,
  reqHeaders: Headers,
): Record<string, string> {
  const upstream: Record<string, string> = {};
  const skip = new Set(["host", "connection", "content-length"]);
  reqHeaders.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) upstream[key] = value;
  });
  if (provider.type === "openai") {
    upstream["authorization"] = `Bearer ${selectedKey}`;
  } else {
    delete upstream["authorization"];
    upstream["x-api-key"] = selectedKey;
    upstream["anthropic-version"] ??= "2023-06-01";
  }
  return upstream;
}

// OpenAI upstream streaming returns more useful token accounting when
// stream_options.include_usage is set. Only applies to Chat Completions;
// Responses API uses its own options.
function buildAttemptBody(
  body: any,
  provider: Provider,
  isResponsesApi: boolean,
  isStreaming: boolean,
): any {
  if (isStreaming && provider.type === "openai" && !isResponsesApi && !body.stream_options) {
    return { ...body, stream_options: { include_usage: true } };
  }
  return body;
}

// top-level entry: iterate the candidate chain in priority order. Each
// attempt either returns a final Response, or a retryable result (HTTP
// 429/5xx/network error) and we continue with the next candidate.
export async function forwardRequest(
  c: Context<AppEnv>,
  candidateProviders: Provider[],
  targetPath: string,
  _routeTrace?: RouteTraceEntry[],
  options?: ForwardOptions,
): Promise<Response> {
  const routeTrace = _routeTrace ?? [];
  const requestId = nanoid();
  const startTime = Date.now();

  const body = await c.req.json();
  const isStreaming = body?.stream === true;
  // When routing via an alias, log the alias name (what the user configured)
  // rather than the resolved real model. The real model per-attempt is tracked
  // separately via resolvedModel in recordRequest.
  const model = options?.aliasName ?? body?.model ?? "unknown";
  const isResponsesApi = !!body?.input && !body?.messages;

  const extractedTags = extractTags({ headers: c.req.raw.headers, path: c.req.path, body, model });
  const agent = extractedTags.agent ?? "";
  const customTags = extractedTags.tags ?? "";

  c.set("recorded", true);
  const token = c.get("authToken");

  const logFile = writeLog(requestId, {
    type: "request",
    timestamp: startTime,
    headers: rebuildHeaders(c),
    body,
  });

  // Bound how long we wait for upstream before giving up. Without
  // this a hung upstream keeps the request "open" in the dashboard
  // for tens of minutes (Node's default socket timeout) and the
  // client has long since given up with "connection error".
  // Streaming requests get a longer window because the response is a
  // continuous stream; non-streaming should resolve in seconds.
  const cfg = getConfig();
  const upstreamTimeoutMs = isStreaming
    ? cfg.server.streamingUpstreamTimeoutMs
    : cfg.server.upstreamTimeoutMs;
  const upstreamController = new AbortController();
  const upstreamTimer = setTimeout(() => upstreamController.abort("upstream_timeout"), upstreamTimeoutMs);
  // If the client (e.g. openclaw, claude-code) disconnects, cancel
  // the upstream request immediately so we don't keep burning a
  // connection to the provider for nothing.
  const onClientAbort = () => upstreamController.abort("client_disconnect");
  if (c.req.raw.signal) {
    if (c.req.raw.signal.aborted) onClientAbort();
    else c.req.raw.signal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    return await runForwardLoop();
  } finally {
    clearTimeout(upstreamTimer);
    if (c.req.raw.signal) c.req.raw.signal.removeEventListener("abort", onClientAbort);
  }

  async function runForwardLoop() {
  // Last non-successful attempt — if every candidate fails, we echo
  // this upstream status + body verbatim to the client, so codex / SDKs
  // see the provider's real error (quota exceeded, auth failure,
  // malformed request, etc.) instead of a generic gateway 502.
  let lastFail: { status: number; body: unknown } | null = null;

  for (let i = 0; i < candidateProviders.length; i++) {
    const provider = candidateProviders[i];
    // When routing via an alias, each provider may serve a different real
    // model from the pool. The real model ID goes in the upstream body;
    // the alias name stays in `model` for logging.
    const realModelId = options?.realModelIds?.get(provider.id);
    const pricingModelId = realModelId ?? model;
    const providerPricing = getModelPricing(provider.models.find((m) => getModelId(m) === pricingModelId)!);
    const { key: selectedKey, index: apiKeyIndex } = selectApiKey(provider);
    const upstreamHeaders = buildTargetHeaders(provider, selectedKey, c.req.raw.headers);
    // Bridge a Responses entry to Chat Completions when the provider asks for
    // it. Per-attempt (not per-request) so a fallback chain can mix bridged
    // and non-bridged providers. The bridge only applies to openai providers
    // serving a Responses entry; everything else is verbatim pass-through.
    const bridge = needsResponsesBridge(provider, isResponsesApi);
    const effectiveTargetPath = bridge ? "/chat/completions" : targetPath;
    const targetUrl = `${provider.baseUrl}${effectiveTargetPath}`;
    // Rewrite body.model to the real model ID so upstream receives a
    // model name it actually recognises. Only needed for alias routing;
    // direct requests already carry the real ID.
    const bodyForAttempt = realModelId ? { ...body, model: realModelId } : body;
    const convertedBody = bridge ? responsesRequestToChat(bodyForAttempt) : bodyForAttempt;
    // buildAttemptBody adds stream_options.include_usage for Chat Completions
    // streaming. When bridging, convertedBody is already chat-shaped, so pass
    // isResponsesApi=false so the usage option is added (Codex relies on the
    // final usage chunk to populate response.completed.usage).
    const attemptBody = buildAttemptBody(convertedBody, provider, bridge ? false : isResponsesApi, isStreaming);

    writeLog(requestId, {
      type: "attempt_request",
      timestamp: Date.now(),
      attemptIndex: i,
      attemptProvider: provider.id,
      attemptTargetUrl: targetUrl,
      headers: upstreamHeaders,
      body: attemptBody,
    });

    const attemptResult = await attemptProvider({
      c,
      provider,
      targetUrl,
      upstreamHeaders,
      attemptBody,
      isStreaming,
      isResponsesApi,
      bridge,
      requestId,
      startTime,
      token,
      logFile,
      apiKeyIndex,
      providerPricing,
      agent,
      customTags,
      routeTrace,
      model,
      attemptIndex: i,
      upstreamSignal: upstreamController.signal,
      resolvedModel: realModelId,
    });

    if (attemptResult.kind === "success") {
      return attemptResult.response;
    }

    const latencyMs = Date.now() - startTime;
    // reason is for the human-readable route_trace label. body holds
    // the actual upstream payload (or a synthetic { error } for network
    // failures) — both are preserved for the dashboard and for the
    // final-fail echo.
    const reason = attemptResult.body && typeof attemptResult.body === "object"
      && (attemptResult.body as any).error === "client_disconnect" ? "client_disconnect"
      : attemptResult.body && typeof attemptResult.body === "object"
      && (attemptResult.body as any).error === "upstream_timeout" ? "upstream_timeout"
      : typeof attemptResult.body === "string" && attemptResult.body.includes("ECONN") ? "network_error"
      : typeof attemptResult.body === "string" ? "network_error"
      : `http_${attemptResult.status}`;

    lastFail = { status: attemptResult.status, body: attemptResult.body };
    routeTrace.push({
      provider: provider.id,
      status: attemptResult.status,
      latencyMs,
      reason,
      errorBody: attemptResult.body,
    });
    // Record every attempt in request_index so the dashboard's requests
    // list reflects each provider's status; the final-fail overwrite
    // below ensures the terminal row matches what the client received.
    const recordError = typeof attemptResult.body === "string"
      ? attemptResult.body
      : (attemptResult.body && typeof attemptResult.body === "object" && (attemptResult.body as any)?.error)
        ? String((attemptResult.body as any).error)
        : undefined;
    recordRequest({
      id: requestId,
      tokenId: token.key,
      providerId: provider.id,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs,
      ttftMs: attemptResult.ttftMs,
      status: attemptResult.status,
      logFile,
      error: recordError,
      apiKeyIndex,
      pricing: providerPricing,
      currency: provider.currency,
      agent,
      customTags,
      routeTrace,
      startTime,
      resolvedModel: realModelId,
    });

    // Client disconnected — there's nobody to receive a fallback
    // response. Stop here instead of burning upstream quota.
    if (reason === "client_disconnect") break;

    if (i < candidateProviders.length - 1) {
      console.log(`[tokenparty] Falling back from ${provider.id} to ${candidateProviders[i + 1].id} for model ${model} (${reason})`);
    }
  }

  // Every candidate failed (or client aborted). Echo the last upstream
  // error verbatim so the client sees the real cause; use 504 only when
  // the failure was at the network layer with no upstream body to show.
  const finalStatus = lastFail && lastFail.status !== 502 ? lastFail.status : 504;
  const finalBody: unknown = lastFail?.body ?? { error: "All provider candidates failed" };

  writeLog(requestId, {
    type: "response",
    timestamp: Date.now(),
    status: finalStatus,
    body: finalBody,
  });
  return c.json(finalBody, finalStatus as any);
  }
}

function rebuildHeaders(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

interface AttemptParams {
  c: Context<AppEnv>;
  provider: Provider;
  targetUrl: string;
  upstreamHeaders: Record<string, string>;
  attemptBody: any;
  isStreaming: boolean;
  isResponsesApi: boolean;
  // True when this attempt bridges Responses -> Chat Completions. The
  // request body is already converted by the caller; the response (and
  // streaming SSE) must be converted back to Responses format here.
  bridge: boolean;
  requestId: string;
  startTime: number;
  token: { key: string };
  logFile: string;
  apiKeyIndex: number;
  providerPricing?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number };
  agent: string;
  customTags: string;
  routeTrace: RouteTraceEntry[];
  model: string;
  attemptIndex: number;
  upstreamSignal: AbortSignal;
  // Real model ID when routing via an alias. Undefined for direct requests.
  resolvedModel?: string;
}

// One upstream attempt. Two paths:
//   - Streaming: same-protocol pass-through via http.request + Transform,
//     streamSSE-agnostic; the bytes are forwarded verbatim.
//   - Non-streaming: a single fetch + decompressed JSON, returned.
// Anything that isn't a clean 2xx is returned as `kind: "fail"` carrying
// the upstream status + raw body. The forwarder loop decides whether to
// try the next candidate or echo this failure verbatim to the client.
// Network-level errors (fetch threw / socket died / client aborted) are
// also `fail` with a synthetic 502 + { error } body.
async function attemptProvider(params: AttemptParams): Promise<AttemptResult> {
  const {
    c, provider, targetUrl, upstreamHeaders, attemptBody, isStreaming, isResponsesApi,
    bridge, requestId, startTime, token, logFile, apiKeyIndex, providerPricing,
    agent, customTags, routeTrace, model, attemptIndex,
  } = params;

  try {
    if (isStreaming) {
      const result = await rawStreamPassthrough({
        targetUrl, upstreamHeaders, body: attemptBody, requestId, provider,
        model, token, startTime, logFile, apiKeyIndex, pricing: providerPricing,
        agent, customTags, routeTrace, attemptIndex, upstreamSignal: params.upstreamSignal,
        // When bridging, pipe upstream Chat Completions SSE through the
        // converter before the logging-capture transform. The capture then
        // sees Responses-format bytes, which asyncParseBufferForLog already
        // understands (response.output_text.delta / response.completed).
        streamTransform: bridge ? new ChatToResponsesSseTransform(model) : undefined,
        resolvedModel: params.resolvedModel,
      });
      if (result.kind === "fail") return result;
      routeTrace.push({ provider: provider.id, status: 200, latencyMs: 0 });
      return { kind: "success", response: result.response, ttftMs: result.ttftMs };
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(attemptBody),
      signal: params.upstreamSignal,
    });

    // Any non-2xx: read the upstream's raw error body and return it as
    // a `fail`. The forwarder loop either retries the next candidate
    // or, if this was the last, echoes this body verbatim to the client
    // — so providers' real error messages (quota exceeded, auth
    // failure, malformed request) reach the user instead of being
    // swallowed into a generic gateway 502.
    if (response.status < 200 || response.status >= 300) {
      const errorText = await response.text().catch(() => "");
      // .text() fully drains the body, so there's nothing left to cancel.
      // Explicitly calling .cancel() here would throw "ReadableStream is
      // locked" on Node's undici and let the outer catch swallow the
      // upstream's real error into a synthetic network_error.
      let errorBody: unknown = errorText;
      try { errorBody = JSON.parse(errorText); } catch {}
      writeLog(requestId, {
        type: "attempt_response",
        timestamp: Date.now(),
        attemptIndex,
        attemptProvider: provider.id,
        status: response.status,
        body: errorText.slice(0, 8000),
      });
      return { kind: "fail", status: response.status, body: errorBody, ttftMs: Date.now() - startTime };
    }

    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { respHeaders[key] = value; });
    const latencyMs = Date.now() - startTime;
    const rawBody = await decompressJson(response);
    // Convert Chat Completions -> Responses when bridging. extractUsage()
    // reads the converted usage shape via its ?? fallback chain, so metrics
    // and logging work without a special case.
    const body = bridge ? chatResponseToResponses(rawBody, "resp_" + requestId) : rawBody;
    const usage = extractUsage(body, provider.type);

    writeLog(requestId, {
      type: "attempt_response",
      timestamp: Date.now(),
      attemptIndex,
      attemptProvider: provider.id,
      headers: respHeaders,
      body,
      usage,
      status: response.status,
    });

    routeTrace.push({ provider: provider.id, status: response.status, latencyMs });
    recordRequest({
      id: requestId,
      tokenId: token.key,
      providerId: provider.id,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_tokens ?? 0,
      cacheWriteTokens: usage?.cache_write_tokens ?? 0,
      latencyMs,
      ttftMs: latencyMs, // non-streaming: ttft = full round-trip
      status: response.status,
      logFile,
      apiKeyIndex,
      pricing: providerPricing,
      currency: provider.currency,
      agent,
      customTags,
      routeTrace,
      startTime,
      resolvedModel: params.resolvedModel,
    });

    return { kind: "success", response: c.json(body, response.status as any), ttftMs: latencyMs };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    // AbortError: the signal's `reason` carries the real cause
    // (upstream_timeout / client_disconnect). Without this, Node's
    // undici surfaces a generic "The operation was aborted" and the
    // main loop would mis-classify the fail as network_error.
    const isAbort = error?.name === "AbortError" || params.upstreamSignal.aborted;
    const abortReason = isAbort ? String(params.upstreamSignal.reason ?? "aborted") : undefined;
    const failBody = abortReason
      ? { error: abortReason }
      : { error: error?.message ?? "network_error" };
    writeLog(requestId, {
      type: "attempt_response",
      timestamp: Date.now(),
      attemptIndex,
      attemptProvider: provider.id,
      error: error?.message,
    });
    return { kind: "fail", status: 502, body: failBody, ttftMs: latencyMs };
  }
}

interface RawStreamPassthroughParams {
  targetUrl: string;
  upstreamHeaders: Record<string, string>;
  body: any;
  requestId: string;
  provider: Provider;
  model: string;
  token: { key: string };
  startTime: number;
  logFile: string;
  apiKeyIndex: number;
  pricing?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number };
  agent?: string;
  customTags?: string;
  routeTrace?: RouteTraceEntry[];
  attemptIndex: number;
  upstreamSignal: AbortSignal;
  // Optional transform inserted between upstream and the logging-capture
  // transform. Used by the Responses->Chat bridge to convert Chat
  // Completions SSE into Responses SSE in-stream. Undefined = verbatim.
  streamTransform?: Transform;
  // Real model ID when routing via an alias. Passed through to the async
  // log parser so streaming requests also record resolved_model.
  resolvedModel?: string;
}

// Same-protocol streaming pass-through. Pipes the upstream body through
// a Transform that also captures bytes for an async log-parse job; the
// pipeline's first chunk is when true TTFT is observed.
function rawStreamPassthrough(params: RawStreamPassthroughParams): Promise<AttemptResult> {
  const {
    targetUrl, upstreamHeaders, body, requestId, provider, model, token,
    startTime, logFile, apiKeyIndex, pricing, agent, customTags, routeTrace, attemptIndex, upstreamSignal,
    streamTransform, resolvedModel,
  } = params;

  const url = new URL(targetUrl);
  const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const keepAliveAgent = url.protocol === "https:" ? httpsAgent : httpAgent;
    // When bridging streaming, the streamTransform must parse the upstream
    // SSE as text - so force the upstream to send uncompressed (identity).
    // The converted Responses SSE we emit is itself uncompressed, so we also
    // drop any content-encoding from the passthrough headers below.
    const reqHeaders: Record<string, string> = { ...upstreamHeaders, "content-type": "application/json" };
    if (streamTransform) reqHeaders["accept-encoding"] = "identity";
    const req = reqFn(url, {
      method: "POST",
      headers: reqHeaders,
      agent: keepAliveAgent,
    }, async (res) => {
      if (upstreamSignal.aborted) {
        // Client already disconnected or upstream timeout fired before
        // the response arrived. Tear down immediately.
        res.destroy();
        const reason = upstreamSignal.reason === "client_disconnect" ? "client_disconnect" : "upstream_timeout";
        writeLog(requestId, {
          type: "attempt_response",
          timestamp: Date.now(),
          attemptIndex,
          attemptProvider: provider.id,
          error: reason,
        });
        resolve({ kind: "fail", status: 502, body: { error: reason }, ttftMs: Date.now() - startTime });
        return;
      }
      const respHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(res.headers)) {
        if (val) respHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
      }
      const status = res.statusCode ?? 502;

      // Any non-2xx: drain the upstream error body so it can be echoed
      // verbatim to the client (or carried forward to the next attempt).
      // Without this the streaming path would lose the provider's real
      // error message and degrade to a generic gateway 502.
      if (status < 200 || status >= 300) {
        const errorBody = await readErrorBody(res);
        writeLog(requestId, {
          type: "attempt_response",
          timestamp: Date.now(),
          attemptIndex,
          attemptProvider: provider.id,
          status,
          body: typeof errorBody === "string" ? errorBody.slice(0, 8000) : errorBody,
        });
        resolve({ kind: "fail", status, body: errorBody, ttftMs: Date.now() - startTime });
        return;
      }

      const passthroughHeaders = new Headers();
      const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);
      for (const [key, val] of Object.entries(res.headers)) {
        if (val && !hopByHop.has(key.toLowerCase())) {
          passthroughHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
        }
      }
      // Bridging converts the body in-stream; the output is uncompressed
      // Responses SSE, so a stale upstream content-encoding/content-length
      // must not be forwarded to the client.
      if (streamTransform) {
        passthroughHeaders.delete("content-encoding");
        passthroughHeaders.delete("content-length");
        passthroughHeaders.set("content-type", "text/event-stream; charset=utf-8");
      }

      // Time To First Byte: capture the first chunk through Transform so
      // the recorded TTFT reflects actual upstream latency, not when the
      // flush() fires after the stream ends.
      let firstChunkAt: number | null = null;
      const rawChunks: Buffer[] = [];
      const passthrough = new Transform({
        transform(chunk, _encoding, callback) {
          rawChunks.push(Buffer.from(chunk));
          if (firstChunkAt === null) firstChunkAt = Date.now();
          callback(null, chunk);
        },
        flush(callback) {
          const ttftMs = (firstChunkAt ?? Date.now()) - startTime;
          asyncParseBufferForLog(
            rawChunks, res.headers["content-encoding"] as string | undefined,
            requestId, respHeaders, provider, model, token, startTime, logFile,
            apiKeyIndex, pricing, agent, customTags, routeTrace, status, attemptIndex, ttftMs,
            resolvedModel,
          );
          callback();
        },
      });

      // Pipe chain: upstream -> [streamTransform (bridge only)] -> capture.
      // The capture transform records bytes for the async log parse; when
      // bridging it records the CONVERTED Responses SSE, which the log
      // parser already understands.
      const sourceStream = streamTransform ? res.pipe(streamTransform) : res;
      const stream = Readable.toWeb(sourceStream.pipe(passthrough) as unknown as Readable) as ReadableStream<Uint8Array>;
      const ttftMs = (firstChunkAt ?? Date.now()) - startTime;
      resolve({ kind: "success", response: new Response(stream, { status, headers: passthroughHeaders }), ttftMs });
    });

    req.on("error", (error) => {
      const isAbort = upstreamSignal.aborted;
      const abortReason = isAbort ? String(upstreamSignal.reason ?? "aborted") : undefined;
      const failBody = abortReason
        ? { error: abortReason }
        : { error: error?.message ?? "network_error" };
      writeLog(requestId, {
        type: "attempt_response",
        timestamp: Date.now(),
        attemptIndex,
        attemptProvider: provider.id,
        error: error?.message,
      });
      resolve({ kind: "fail", status: 502, body: failBody, ttftMs: Date.now() - startTime });
    });
    // Cancel the in-flight http.request when the upstream signal fires
    // (timeout or client disconnect). req.destroy forces the socket
    // closed and the pending "error" handler above to resolve the
    // promise with a clean 502.
    upstreamSignal.addEventListener("abort", () => {
      if (!req.destroyed) req.destroy(new Error(upstreamSignal.reason === "client_disconnect" ? "client_disconnect" : "upstream_timeout"));
    }, { once: true });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Async log-parse for rawStreamPassthrough: decode the captured chunks
// (gzip / brotli / etc.), pull out SSE events, and record the request
// with TTFT + token usage from the upstream.
function asyncParseBufferForLog(
  rawChunks: Buffer[],
  encoding: string | undefined,
  requestId: string,
  respHeaders: Record<string, string>,
  provider: Provider,
  model: string,
  token: { key: string },
  startTime: number,
  logFile: string,
  apiKeyIndex: number,
  pricing?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number },
  agent?: string,
  customTags?: string,
  routeTrace?: RouteTraceEntry[],
  upstreamStatus?: number,
  attemptIndex?: number,
  ttftMs?: number,
  resolvedModel?: string,
) {
  (async () => {
    let text: string;
    const combined = Buffer.concat(rawChunks);
    if (encoding && ["gzip", "deflate", "br", "zstd"].includes(encoding)) {
      const { promisify } = await import("node:util");
      const zlib = await import("node:zlib");
      const decompressFn: Record<string, (buf: Buffer) => Promise<Buffer>> = {
        gzip: promisify(zlib.gunzip) as any,
        deflate: promisify(zlib.inflate) as any,
        br: promisify(zlib.brotliDecompress) as any,
        zstd: promisify(zlib.zstdDecompress) as any,
      };
      text = (await decompressFn[encoding](combined)).toString("utf-8");
    } else {
      text = combined.toString("utf-8");
    }

    const contentType = respHeaders["content-type"] ?? "";
    const isSse = contentType.includes("text/event-stream");
    const recordedStatus = upstreamStatus ?? 200;
    let fullContent = "";
    let rawEvents: any[] = [];
    let usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number } | undefined;
    let responseBody: unknown;

    if (isSse) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          rawEvents.push(parsed);
          if (provider.type === "anthropic" && parsed.type === "content_block_delta") {
            if (parsed.delta?.text) fullContent += parsed.delta.text;
            if (parsed.delta?.thinking) fullContent += parsed.delta.thinking;
          } else if (provider.type === "openai" && parsed.choices?.[0]?.delta?.content) {
            fullContent += parsed.choices[0].delta.content;
          } else if (parsed.type === "response.output_text.delta" && parsed.delta) {
            fullContent += parsed.delta;
          }
          usage = extractUsageFromChunk(parsed, provider.type) ?? usage;
        } catch {}
      }
      if (!usage) {
        for (let i = rawEvents.length - 1; i >= 0; i--) {
          const evt = rawEvents[i];
          if (evt.type === "response.completed" && evt.response?.usage) {
            usage = {
              input_tokens: evt.response.usage.input_tokens ?? 0,
              output_tokens: evt.response.usage.output_tokens ?? 0,
              cache_read_tokens: evt.response.usage.cache_read_input_tokens ?? 0,
              cache_write_tokens: evt.response.usage.cache_creation_input_tokens ?? 0,
            };
            break;
          }
          if (evt.usage && typeof evt.usage === "object" && (evt.usage.prompt_tokens || evt.usage.completion_tokens || evt.usage.input_tokens || evt.usage.output_tokens || evt.usage.total_tokens)) {
            usage = {
              input_tokens: evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? 0,
              output_tokens: evt.usage.completion_tokens ?? evt.usage.output_tokens ?? 0,
              cache_read_tokens: evt.usage.prompt_tokens_details?.cached_tokens ?? evt.usage.cache_read_input_tokens ?? 0,
              cache_write_tokens: evt.usage.cache_creation_input_tokens ?? 0,
            };
            break;
          }
        }
      }
      responseBody = rawEvents;
    } else {
      try {
        responseBody = JSON.parse(text);
        usage = extractUsage(responseBody, provider.type);
      } catch {
        responseBody = text;
      }
    }

    writeLog(requestId, {
      type: "attempt_response",
      timestamp: Date.now(),
      attemptIndex,
      attemptProvider: provider.id,
      headers: respHeaders,
      streaming: isSse,
      streamContent: isSse ? fullContent : undefined,
      body: responseBody,
      usage,
      status: recordedStatus,
    });
    recordRequest({
      id: requestId,
      tokenId: token.key,
      providerId: provider.id,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_tokens ?? 0,
      cacheWriteTokens: usage?.cache_write_tokens ?? 0,
      latencyMs: Date.now() - startTime,
      ttftMs: ttftMs ?? 0,
      status: recordedStatus,
      logFile,
      apiKeyIndex,
      pricing,
      currency: provider.currency,
      agent,
      customTags,
      routeTrace,
      startTime,
      resolvedModel,
    });
  })().catch((e) => console.error(`[tokenparty] async log parse error for ${requestId}:`, e));
}

// --- Token usage extraction ---

function extractUsage(body: any, providerType: string) {
  if (!body?.usage) return undefined;
  if (providerType === "openai") {
    return {
      input_tokens: body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0,
      output_tokens: body.usage.completion_tokens ?? body.usage.output_tokens ?? 0,
      cache_read_tokens: body.usage.prompt_tokens_details?.cached_tokens ?? body.usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: body.usage.cache_creation_input_tokens ?? 0,
    };
  }
  if (providerType === "anthropic") {
    return {
      input_tokens: body.usage.input_tokens ?? 0,
      output_tokens: body.usage.output_tokens ?? 0,
      cache_read_tokens: body.usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: body.usage.cache_creation_input_tokens ?? 0,
    };
  }
  return undefined;
}

function extractUsageFromChunk(parsed: any, providerType: string) {
  if (providerType === "openai") {
    if (parsed.type === "response.completed" && parsed.response?.usage) {
      return {
        input_tokens: parsed.response.usage.input_tokens ?? 0,
        output_tokens: parsed.response.usage.output_tokens ?? 0,
        cache_read_tokens: parsed.response.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: parsed.response.usage.cache_creation_input_tokens ?? 0,
      };
    }
    if (parsed.usage) {
      return {
        input_tokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
        output_tokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
        cache_read_tokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? parsed.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: parsed.usage.cache_creation_input_tokens ?? 0,
      };
    }
  }
  if (providerType === "anthropic") {
    if (parsed.type === "message_delta" && parsed.usage) {
      return { input_tokens: parsed.usage.input_tokens ?? 0, output_tokens: parsed.usage.output_tokens ?? 0, cache_read_tokens: parsed.usage.cache_read_input_tokens ?? 0, cache_write_tokens: parsed.usage.cache_creation_input_tokens ?? 0 };
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      return { input_tokens: parsed.message.usage.input_tokens ?? 0, output_tokens: 0, cache_read_tokens: parsed.message.usage.cache_read_input_tokens ?? 0, cache_write_tokens: parsed.message.usage.cache_creation_input_tokens ?? 0 };
    }
  }
  return undefined;
}

async function decompressJson(response: Response): Promise<any> {
  const encoding = response.headers.get("content-encoding");
  if (!encoding || !["zstd"].includes(encoding)) {
    return response.json();
  }
  const stream = decompressResponse(response);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text);
}

// Drain a Node IncomingMessage (used for streaming upstream error
// responses) into a string, applying the same decompression we use for
// fetch responses. Tries to parse as JSON; falls back to the raw text.
async function readErrorBody(res: IncomingMessage): Promise<unknown> {
  const encoding = (res.headers["content-encoding"] as string | undefined) ?? "";
  const decoders: Record<string, () => NodeJS.ReadWriteStream> = {
    gzip: createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
    zstd: createZstdDecompress,
  };
  const source: NodeJS.ReadableStream = decoders[encoding] ? res.pipe(decoders[encoding]()) : res;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } catch {}
  const text = Buffer.concat(chunks).toString("utf-8");
  try { return JSON.parse(text); } catch { return text; }
}

function decompressResponse(response: Response): ReadableStream<Uint8Array> {
  const encoding = response.headers.get("content-encoding");
  if (!encoding || !response.body) return response.body!;

  const decompressors: Record<string, () => NodeJS.ReadWriteStream> = {
    gzip: createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
    zstd: createZstdDecompress,
  };

  const create = decompressors[encoding];
  if (!create) return response.body;

  const decompressor = create();
  const nodeStream = Readable.fromWeb(response.body as any);
  const decompressed = nodeStream.pipe(decompressor) as unknown as Readable;
  return Readable.toWeb(decompressed) as ReadableStream<Uint8Array>;
}

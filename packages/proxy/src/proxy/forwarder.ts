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
import { Agent as HttpAgent, request as httpRequest } from "node:http";

// Shared keepAlive agents for connection pooling. Without these, every
// outgoing request opens a new TCP connection, causing TIME_WAIT
// accumulation and ephemeral port exhaustion under sustained load.
const httpAgent = new HttpAgent({ keepAlive: true, maxFreeSockets: 20, keepAliveMsecs: 30_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxFreeSockets: 20, keepAliveMsecs: 30_000 });

export type RouteTraceEntry = { provider: string; status: number | null; latencyMs: number; reason?: string };

type AttemptResult =
  | { kind: "done"; response: Response; ttftMs: number }
  | { kind: "retryable"; status: number; error?: string; ttftMs: number };

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

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
): Promise<Response> {
  const routeTrace = _routeTrace ?? [];
  const requestId = nanoid();
  const startTime = Date.now();

  const body = await c.req.json();
  const isStreaming = body?.stream === true;
  const model = body?.model ?? "unknown";
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
  for (let i = 0; i < candidateProviders.length; i++) {
    const provider = candidateProviders[i];
    const providerPricing = getModelPricing(provider.models.find((m) => getModelId(m) === model)!);
    const { key: selectedKey, index: apiKeyIndex } = selectApiKey(provider);
    const upstreamHeaders = buildTargetHeaders(provider, selectedKey, c.req.raw.headers);
    const targetUrl = `${provider.baseUrl}${targetPath}`;
    const attemptBody = buildAttemptBody(body, provider, isResponsesApi, isStreaming);

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
    });

    if (attemptResult.kind === "done") {
      return attemptResult.response;
    }

    const latencyMs = Date.now() - startTime;
    const reason = attemptResult.status === 429 ? "rate_limited"
      : attemptResult.error ? "network_error"
      : `http_${attemptResult.status}`;

    routeTrace.push({ provider: provider.id, status: attemptResult.status, latencyMs, reason });
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
      error: attemptResult.error,
      apiKeyIndex,
      pricing: providerPricing,
      currency: provider.currency,
      agent,
      customTags,
      routeTrace,
      startTime,
    });

    if (i < candidateProviders.length - 1) {
      console.log(`[tokenparty] Falling back from ${provider.id} to ${candidateProviders[i + 1].id} for model ${model} (${reason})`);
    }
  }

  writeLog(requestId, {
    type: "response",
    timestamp: Date.now(),
    status: 502,
    error: "All provider candidates failed",
  });
  return c.json({ error: "All provider candidates failed" }, 502);
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
}

// One upstream attempt. Two paths:
//   - Streaming: same-protocol pass-through via http.request + Transform,
//     streamSSE-agnostic; the bytes are forwarded verbatim.
//   - Non-streaming: a single fetch + decompressed JSON, returned.
// The retryable-vs-final decision is the same in both paths: 429/5xx
// (or a thrown network error) means "skip to next candidate". 4xx that
// isn't 429 is final (treating it as retryable would let a bad key /
// bad request cycle through every provider).
async function attemptProvider(params: AttemptParams): Promise<AttemptResult> {
  const {
    c, provider, targetUrl, upstreamHeaders, attemptBody, isStreaming, isResponsesApi,
    requestId, startTime, token, logFile, apiKeyIndex, providerPricing,
    agent, customTags, routeTrace, model, attemptIndex,
  } = params;

  try {
    if (isStreaming) {
      const result = await rawStreamPassthrough({
        targetUrl, upstreamHeaders, body: attemptBody, requestId, provider,
        model, token, startTime, logFile, apiKeyIndex, pricing: providerPricing,
        agent, customTags, routeTrace, attemptIndex, upstreamSignal: params.upstreamSignal,
      });
      if (result.kind === "retryable") return result;
      routeTrace.push({ provider: provider.id, status: 200, latencyMs: 0 });
      return { kind: "done", response: result.response, ttftMs: result.ttftMs };
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(attemptBody),
      signal: params.upstreamSignal,
    });

    if (isRetryableStatus(response.status)) {
      const errorText = await response.text().catch(() => "");
      writeLog(requestId, {
        type: "attempt_response",
        timestamp: Date.now(),
        attemptIndex,
        attemptProvider: provider.id,
        status: response.status,
        body: errorText.slice(0, 8000),
      });
      await response.body?.cancel();
      return { kind: "retryable", status: response.status, ttftMs: Date.now() - startTime };
    }

    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { respHeaders[key] = value; });
    const latencyMs = Date.now() - startTime;
    const body = await decompressJson(response);
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
    });

    return { kind: "done", response: c.json(body, response.status as any), ttftMs: latencyMs };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    writeLog(requestId, {
      type: "attempt_response",
      timestamp: Date.now(),
      attemptIndex,
      attemptProvider: provider.id,
      error: error.message,
    });
    return { kind: "retryable", status: 502, error: error.message, ttftMs: latencyMs };
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
}

// Same-protocol streaming pass-through. Pipes the upstream body through
// a Transform that also captures bytes for an async log-parse job; the
// pipeline's first chunk is when true TTFT is observed.
function rawStreamPassthrough(params: RawStreamPassthroughParams): Promise<AttemptResult> {
  const {
    targetUrl, upstreamHeaders, body, requestId, provider, model, token,
    startTime, logFile, apiKeyIndex, pricing, agent, customTags, routeTrace, attemptIndex, upstreamSignal,
  } = params;

  const url = new URL(targetUrl);
  const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const keepAliveAgent = url.protocol === "https:" ? httpsAgent : httpAgent;
    const req = reqFn(url, {
      method: "POST",
      headers: { ...upstreamHeaders, "content-type": "application/json" },
      agent: keepAliveAgent,
    }, (res) => {
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
        resolve({ kind: "retryable", status: 502, error: reason, ttftMs: Date.now() - startTime });
        return;
      }
      const respHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(res.headers)) {
        if (val) respHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
      }
      const status = res.statusCode ?? 502;

      if (isRetryableStatus(status)) {
        res.destroy();
        writeLog(requestId, {
          type: "attempt_response",
          timestamp: Date.now(),
          attemptIndex,
          attemptProvider: provider.id,
          status,
        });
        resolve({ kind: "retryable", status, ttftMs: Date.now() - startTime });
        return;
      }

      const passthroughHeaders = new Headers();
      const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);
      for (const [key, val] of Object.entries(res.headers)) {
        if (val && !hopByHop.has(key.toLowerCase())) {
          passthroughHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
        }
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
          );
          callback();
        },
      });

      const stream = Readable.toWeb(res.pipe(passthrough) as unknown as Readable) as ReadableStream<Uint8Array>;
      const ttftMs = (firstChunkAt ?? Date.now()) - startTime;
      resolve({ kind: "done", response: new Response(stream, { status, headers: passthroughHeaders }), ttftMs });
    });

    req.on("error", (error) => {
      writeLog(requestId, {
        type: "attempt_response",
        timestamp: Date.now(),
        attemptIndex,
        attemptProvider: provider.id,
        error: error.message,
      });
      resolve({ kind: "retryable", status: 502, error: error.message, ttftMs: Date.now() - startTime });
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

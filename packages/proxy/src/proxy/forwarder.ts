import type { Context } from "hono";
import type { AppEnv } from "../types/env.js";
import { streamSSE } from "hono/streaming";
import type { Provider } from "../types/config.js";
import { getModelId, getModelPricing } from "../types/config.js";
import { getConfig } from "../config.js";
import { nanoid } from "nanoid";
import { writeLog, headersToRecord } from "../store/log-writer.js";
import { recordRequest } from "../metrics/collector.js";
import { createGunzip, createInflate, createBrotliDecompress, createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";

export type EntryProtocol = "openai" | "anthropic";

const roundRobinCounters = new Map<string, number>();

function selectApiKey(provider: Provider): { key: string; index: number } {
  const keys = Array.isArray(provider.apiKey) ? provider.apiKey : [provider.apiKey];
  if (keys.length === 1) return { key: keys[0], index: 0 };
  const counter = (roundRobinCounters.get(provider.id) ?? -1) + 1;
  const index = counter % keys.length;
  roundRobinCounters.set(provider.id, counter);
  return { key: keys[index], index };
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export async function forwardRequest(
  c: Context<AppEnv>,
  provider: Provider,
  targetPath: string,
  transformedBody?: unknown,
  entryProtocol?: EntryProtocol,
  pricing?: { inputPrice?: number; outputPrice?: number }
): Promise<Response> {
  const requestId = nanoid();
  const startTime = Date.now();

  const body = transformedBody ?? (await c.req.json());
  const isStreaming = body?.stream === true;
  const model = body?.model ?? "unknown";
  const entry = entryProtocol ?? provider.type;
  const needsStreamConversion = isStreaming && entry !== provider.type;

  const isResponsesApi = !!body?.input && !body?.messages;

  // Request usage in streaming for OpenAI chat completions (not responses API)
  if (isStreaming && provider.type === "openai" && !isResponsesApi && !body.stream_options) {
    body.stream_options = { include_usage: true };
  }

  const targetUrl = `${provider.baseUrl}${targetPath}`;
  const { key: selectedKey, index: apiKeyIndex } = selectApiKey(provider);

  const upstreamHeaders: Record<string, string> = {};
  const skipHeaders = new Set(["host", "connection", "content-length"]);
  c.req.raw.headers.forEach((value, key) => {
    if (!skipHeaders.has(key.toLowerCase())) {
      upstreamHeaders[key] = value;
    }
  });

  if (provider.type === "openai") {
    upstreamHeaders["authorization"] = `Bearer ${selectedKey}`;
  } else if (provider.type === "anthropic") {
    delete upstreamHeaders["authorization"];
    upstreamHeaders["x-api-key"] = selectedKey;
    upstreamHeaders["anthropic-version"] ??= "2023-06-01";
  }

  // Capture incoming request headers (sanitize auth)
  const reqHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      reqHeaders[key] = value.slice(0, 10) + "****";
    } else {
      reqHeaders[key] = value;
    }
  });

  const logFile = writeLog(requestId, {
    type: "request",
    timestamp: startTime,
    headers: { ...reqHeaders, "x-target-url": targetUrl, "x-entry-protocol": entry, "x-provider-type": provider.type, "x-api-key-index": String(apiKeyIndex), "x-api-key-used": maskApiKey(selectedKey) },
    body,
  });

  const token = c.get("authToken");

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    const respHeaders = headersToRecord(response.headers);
    const latencyMs = Date.now() - startTime;

    if (isStreaming && response.ok) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return streamSSE(c, async (s) => {
        const reader = decompressResponse(response).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let rawEvents: any[] = [];
        let usage: { input_tokens: number; output_tokens: number } | undefined;
        let chunkId = `chatcmpl-${requestId}`;
        const o2aConverter = new OpenaiToAnthropicStreamConverter();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") {
                await s.writeSSE({ data: "[DONE]" });
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                rawEvents.push(parsed);

                if (needsStreamConversion && provider.type === "anthropic" && entry === "openai") {
                  const converted = convertAnthropicChunkToOpenai(parsed, model, chunkId);
                  if (converted) {
                    if (converted.content) fullContent += converted.content;
                    await s.writeSSE({ data: JSON.stringify(converted.chunk) });
                  }
                  if (parsed.type === "message_delta" && parsed.usage) {
                    usage = { input_tokens: parsed.usage.input_tokens ?? 0, output_tokens: parsed.usage.output_tokens ?? 0 };
                  }
                  if (parsed.type === "message_start" && parsed.message?.usage) {
                    usage = { ...usage, input_tokens: parsed.message.usage.input_tokens ?? 0 } as any;
                  }
                } else if (needsStreamConversion && provider.type === "openai" && entry === "anthropic") {
                  const converted = o2aConverter.convert(parsed, model);
                  if (converted) {
                    for (const event of converted.events) {
                      await s.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
                    }
                    if (converted.content) fullContent += converted.content;
                  }
                  if (parsed.usage) {
                    usage = { input_tokens: parsed.usage.prompt_tokens ?? 0, output_tokens: parsed.usage.completion_tokens ?? 0 };
                  }
                } else {
                  // Same protocol, pass through — preserve event type
                  if (parsed.type) {
                    await s.writeSSE({ event: parsed.type, data });
                  } else {
                    await s.writeSSE({ data });
                  }
                  if (provider.type === "anthropic" && parsed.type === "content_block_delta") {
                    if (parsed.delta?.text) fullContent += parsed.delta.text;
                    if (parsed.delta?.thinking) fullContent += parsed.delta.thinking;
                  } else if (provider.type === "openai" && parsed.choices?.[0]?.delta?.content) {
                    fullContent += parsed.choices[0].delta.content;
                  } else if (parsed.type === "response.output_text.delta" && parsed.delta) {
                    fullContent += parsed.delta;
                  }
                  usage = extractUsageFromChunk(parsed, provider.type) ?? usage;
                }
              } catch {}
            }
          }
        } finally {
          // Fallback: scan raw events for usage if not captured during streaming
          if (!usage) {
            for (let i = rawEvents.length - 1; i >= 0; i--) {
              const evt = rawEvents[i];
              if (evt.type === "response.completed" && evt.response?.usage) {
                usage = {
                  input_tokens: evt.response.usage.input_tokens ?? 0,
                  output_tokens: evt.response.usage.output_tokens ?? 0,
                };
                break;
              }
              if (evt.usage && typeof evt.usage === "object" && (evt.usage.prompt_tokens || evt.usage.completion_tokens || evt.usage.input_tokens || evt.usage.output_tokens || evt.usage.total_tokens)) {
                usage = {
                  input_tokens: evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? 0,
                  output_tokens: evt.usage.completion_tokens ?? evt.usage.output_tokens ?? 0,
                };
                break;
              }
            }
          }
          writeLog(requestId, {
            type: "response",
            timestamp: Date.now(),
            headers: respHeaders,
            streaming: true,
            streamContent: fullContent,
            body: rawEvents,
            usage,
          });
          recordRequest({
            id: requestId,
            tokenId: token.key,
            providerId: provider.id,
            model,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            latencyMs: Date.now() - startTime,
            status: response.status,
            logFile,
            apiKeyIndex,
            pricing,
          });
        }
      });
    }

    const responseBody = await decompressJson(response);
    const usage = extractUsage(responseBody, provider.type);

    writeLog(requestId, {
      type: "response",
      timestamp: Date.now(),
      headers: respHeaders,
      body: responseBody,
      usage,
    });

    recordRequest({
      id: requestId,
      tokenId: token.key,
      providerId: provider.id,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      latencyMs,
      status: response.status,
      logFile,
      apiKeyIndex,
      pricing,
    });

    if (response.status >= 500 && provider.fallback) {
      const fallbackResult = tryFallback(c, provider, model, targetPath, body, entryProtocol, requestId);
      if (fallbackResult) return fallbackResult;
    }

    return c.json(responseBody, response.status as any);
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    writeLog(requestId, {
      type: "response",
      timestamp: Date.now(),
      error: error.message,
    });
    recordRequest({
      id: requestId,
      tokenId: token.key,
      providerId: provider.id,
      model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      status: 502,
      logFile,
      error: error.message,
      apiKeyIndex,
      pricing,
    });

    if (provider.fallback) {
      const fallbackResult = tryFallback(c, provider, model, targetPath, body, entryProtocol, requestId);
      if (fallbackResult) return fallbackResult;
    }

    return c.json({ error: "Upstream request failed", detail: error.message }, 502);
  }
}

function tryFallback(
  c: Context<AppEnv>,
  provider: Provider,
  model: string,
  targetPath: string,
  body: any,
  entryProtocol?: EntryProtocol,
  originalRequestId?: string,
): Promise<Response> | null {
  if (!provider.fallback) return null;
  const config = getConfig();
  const fallbackProvider = config.providers.find((p) => p.id === provider.fallback && p.enabled);
  if (!fallbackProvider) return null;

  const modelConfig = fallbackProvider.models.find((m) => getModelId(m) === model);
  if (!modelConfig) return null;

  const fallbackPricing = getModelPricing(modelConfig);

  let fallbackPath = targetPath;
  if (fallbackProvider.type !== provider.type) {
    if (fallbackProvider.type === "anthropic") fallbackPath = "/v1/messages";
    else fallbackPath = "/chat/completions";
  }

  console.log(`[tokenparty] Falling back from ${provider.id} to ${fallbackProvider.id} for model ${model}`);
  return forwardRequest(c, fallbackProvider, fallbackPath, body, entryProtocol, fallbackPricing);
}

// --- Anthropic SSE chunk → OpenAI SSE chunk ---

function convertAnthropicChunkToOpenai(parsed: any, model: string, id: string) {
  if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
    const text = parsed.delta.text ?? "";
    return {
      content: text,
      chunk: {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      },
    };
  }
  if (parsed.type === "message_start") {
    return {
      content: "",
      chunk: {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      },
    };
  }
  if (parsed.type === "message_delta") {
    const finishReason = parsed.delta?.stop_reason === "end_turn" ? "stop"
      : parsed.delta?.stop_reason === "max_tokens" ? "length" : "stop";
    return {
      content: "",
      chunk: {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: parsed.usage ? {
          prompt_tokens: parsed.usage.input_tokens ?? 0,
          completion_tokens: parsed.usage.output_tokens ?? 0,
          total_tokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
        } : undefined,
      },
    };
  }
  return null;
}

// --- OpenAI SSE chunk → Anthropic SSE events ---

class OpenaiToAnthropicStreamConverter {
  private started = false;
  private msgId = "";
  private inputTokens = 0;

  convert(parsed: any, model: string): { events: { type: string; data: any }[]; content: string } | null {
    const events: { type: string; data: any }[] = [];
    let content = "";

    const choice = parsed.choices?.[0];
    if (!choice) {
      if (parsed.usage && typeof parsed.usage === "object" && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens)) {
        this.inputTokens = parsed.usage.prompt_tokens ?? 0;
        events.push({
          type: "message_delta",
          data: {
            type: "message_delta",
            delta: {},
            usage: {
              input_tokens: parsed.usage.prompt_tokens ?? 0,
              output_tokens: parsed.usage.completion_tokens ?? 0,
            },
          },
        });
        return { events, content: "" };
      }
      return null;
    }

    if (!this.started) {
      this.started = true;
      this.msgId = parsed.id ?? `msg_${Date.now()}`;
      events.push({
        type: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            usage: { input_tokens: this.inputTokens, output_tokens: 0 },
          },
        },
      });
      events.push({
        type: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
    }

    if (choice.delta?.content) {
      content = choice.delta.content;
      events.push({
        type: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: content },
        },
      });
    }

    if (choice.finish_reason) {
      const stopReason = choice.finish_reason === "stop" ? "end_turn"
        : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
      events.push({
        type: "content_block_stop",
        data: { type: "content_block_stop", index: 0 },
      });
      events.push({
        type: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stopReason },
          usage: parsed.usage ? {
            input_tokens: parsed.usage.prompt_tokens ?? 0,
            output_tokens: parsed.usage.completion_tokens ?? 0,
          } : { output_tokens: 0 },
        },
      });
    }

    return events.length > 0 ? { events, content } : null;
  }
}

// --- Usage extraction ---

function extractUsage(body: any, providerType: string) {
  if (!body?.usage) return undefined;
  if (providerType === "openai") {
    return {
      input_tokens: body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0,
      output_tokens: body.usage.completion_tokens ?? body.usage.output_tokens ?? 0,
    };
  }
  if (providerType === "anthropic") {
    return {
      input_tokens: body.usage.input_tokens ?? 0,
      output_tokens: body.usage.output_tokens ?? 0,
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
      };
    }
    if (parsed.usage) {
      return {
        input_tokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
        output_tokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
      };
    }
  }
  if (providerType === "anthropic") {
    if (parsed.type === "message_delta" && parsed.usage) {
      return { input_tokens: parsed.usage.input_tokens ?? 0, output_tokens: parsed.usage.output_tokens ?? 0 };
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      return { input_tokens: parsed.message.usage.input_tokens ?? 0, output_tokens: 0 };
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

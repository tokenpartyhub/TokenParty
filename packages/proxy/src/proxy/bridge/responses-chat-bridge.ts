// Responses API <-> Chat Completions protocol bridge.
//
// Isolated from the forwarder: pure request/response converters plus a
// streaming Transform. The forwarder calls into this module only when a
// provider has `responsesToChat: true` AND the entry is a Responses API
// request (body has `input`, no `messages`). Everything lives here so the
// OpenAI-only blast radius is contained - anthropic routes and same-shape
// openai pass-through are untouched.
//
// Phase 1 scope: TEXT ONLY. `tools` / `tool_choice` / `parallel_tool_calls`
// are dropped on the request side, and `tool_calls` are not produced on the
// response side. Tool-call support is added in Phase 2.

import { Transform } from "node:stream";
import { nanoid } from "nanoid";
import type { Provider } from "../../types/config.js";

// True when this attempt should be bridged from Responses -> Chat Completions.
// Only openai providers with the flag set, and only for Responses entries.
export function needsResponsesBridge(provider: Provider, isResponsesApi: boolean): boolean {
  return isResponsesApi && provider.type === "openai" && !!provider.responsesToChat;
}

// Flatten a Responses message `content` (string or array of typed parts)
// into a plain string. Text parts (input_text / output_text / text) are
// concatenated; non-text parts (images, etc.) are dropped - Phase 1 is
// text-only.
function contentPartsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
      .join("");
  }
  return "";
}

// Convert a Responses API request body into a Chat Completions request body.
// `instructions` -> leading system message; `input` (string | item[]) ->
// `messages`. Tools are dropped (Phase 1). Returns a fresh object.
export function responsesRequestToChat(body: any): any {
  const out: Record<string, unknown> = { model: body.model };
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;

  const messages: any[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        messages.push({ role: item.role ?? "user", content: contentPartsToText(item.content) });
      }
      // Phase 1: function_call / function_call_output items are dropped.
    }
  }
  out.messages = messages;
  return out;
}

// Map Chat Completions usage -> Responses usage shape. The forwarder's
// extractUsage() reads this via its `??` fallback chain, so returning
// input_tokens / output_tokens / cache_*_input_tokens works for both
// logging and metrics.
function mapUsage(usage: any): any {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

// Convert a non-streaming Chat Completions response into a Responses API
// response object. Text content only (Phase 1).
export function chatResponseToResponses(body: any, respId: string): any {
  const choice = body?.choices?.[0];
  const text = choice?.message?.content ?? "";
  const msgId = "msg_" + nanoid(24);
  return {
    id: respId,
    object: "response",
    status: "completed",
    model: body?.model ?? "",
    output: [
      {
        id: msgId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: mapUsage(body?.usage),
  };
}

// Streaming transform: consumes Chat Completions SSE bytes, emits Responses
// SSE bytes. Emits the minimal event sequence a Responses client needs for
// text: response.created, output_item.added (message), content_part.added,
// repeated output_text.delta, then on finish: output_text.done,
// content_part.done, output_item.done, response.completed (with usage).
//
// The output is `event: <type>\ndata: <json>\n\n` blocks, matching the
// OpenAI Responses streaming wire format. The forwarder's async log parser
// already understands response.output_text.delta (content) and
// response.completed (usage), so logging works without changes.
export class ChatToResponsesSseTransform extends Transform {
  private buffer = "";
  private readonly respId: string;
  private readonly msgId: string;
  private readonly model: string;
  private started = false;
  private finished = false;
  private textBuf = "";
  private usage: any = null;

  constructor(model: string) {
    super();
    this.respId = "resp_" + nanoid(24);
    this.msgId = "msg_" + nanoid(24);
    this.model = model ?? "";
  }

  private writeEvent(eventType: string, data: any): void {
    this.push(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.writeEvent("response.created", {
      type: "response.created",
      response: { id: this.respId, object: "response", status: "in_progress", model: this.model, output: [] },
    });
    this.writeEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: this.msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.writeEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.writeEvent("response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      text: this.textBuf,
    });
    this.writeEvent("response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: this.textBuf },
    });
    this.writeEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: this.msgId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.textBuf }],
      },
    });
    this.writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id: this.respId,
        object: "response",
        status: "completed",
        model: this.model,
        output: [
          {
            id: this.msgId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: this.textBuf }],
          },
        ],
        usage: this.usage
          ? {
              input_tokens: this.usage.prompt_tokens ?? this.usage.input_tokens ?? 0,
              output_tokens: this.usage.completion_tokens ?? this.usage.output_tokens ?? 0,
              total_tokens: this.usage.total_tokens ?? 0,
            }
          : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.processBlock(block);
    }
    callback();
  }

  _flush(callback: () => void): void {
    const rest = this.buffer.trim();
    if (rest) this.processBlock(this.buffer);
    if (this.started && !this.finished) this.finish();
    callback();
  }

  private processBlock(block: string): void {
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        if (this.started && !this.finished) this.finish();
        return;
      }
      try {
        this.handleChunk(JSON.parse(data));
      } catch {
        // Ignore malformed lines - upstream SSE can emit keepalives/comments.
      }
    }
  }

  private handleChunk(chunk: any): void {
    const choice = chunk?.choices?.[0];
    if (choice) {
      if (!this.started) this.start();
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.textBuf += delta.content;
        this.writeEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: this.msgId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }
    }
    if (chunk?.usage) this.usage = chunk.usage;
  }
}

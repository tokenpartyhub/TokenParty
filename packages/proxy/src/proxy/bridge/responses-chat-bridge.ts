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
// `messages`; `tools` (Responses shape) -> Chat `tools` shape. Consecutive
// `function_call` input items are merged into one assistant message with
// multiple `tool_calls` (parallel tool calls); each `function_call_output`
// becomes a `tool`-role message. Returns a fresh object.
export function responsesRequestToChat(body: any): any {
  const out: Record<string, unknown> = { model: body.model };
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.reasoning?.effort !== undefined) out.reasoning_effort = body.reasoning.effort;

  // Responses tools: [{type:"function", name, description, parameters, strict}]
  // -> Chat tools: [{type:"function", function:{name, description, parameters, strict}}]
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
  }

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
      } else if (item.type === "function_call") {
        // Merge consecutive function_call items into one assistant message
        // (parallel tool calls). A new assistant message is started whenever
        // the previous message isn't a tool-call-bearing assistant message.
        const last = messages[messages.length - 1];
        const tc = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "" } };
        if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
          last.tool_calls.push(tc);
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: [tc] });
        }
      } else if (item.type === "function_call_output") {
        const content = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        messages.push({ role: "tool", tool_call_id: item.call_id, content });
      }
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
// response object. Text content maps to a `message` output item; each
// `tool_calls` entry maps to a `function_call` output item. An empty
// message item is only emitted when there is no tool_calls (so a pure
// tool-call response doesn't carry a redundant empty message).
export function chatResponseToResponses(body: any, respId: string): any {
  const choice = body?.choices?.[0];
  const msg = choice?.message ?? {};
  const text = msg.content ?? "";
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const output: any[] = [];
  if (text || toolCalls.length === 0) {
    output.push({
      id: "msg_" + nanoid(24),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      id: "fc_" + nanoid(24),
      type: "function_call",
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? "",
    });
  }

  return {
    id: respId,
    object: "response",
    status: "completed",
    model: body?.model ?? "",
    output,
    usage: mapUsage(body?.usage),
  };
}

// Streaming transform: consumes Chat Completions SSE bytes, emits Responses
// SSE bytes. Handles both text content and tool calls:
//   - text deltas  -> response.output_text.delta
//   - tool_call deltas -> response.output_item.added (function_call) +
//     response.function_call_arguments.delta
// On finish: closes the message item (if any text), closes each function_call
// item (arguments.done + output_item.done), then response.completed.
//
// The message item is opened lazily (only when text actually arrives) so a
// pure tool-call response doesn't carry an empty message. output_index is
// assigned in arrival order across message + function_call items.
//
// The forwarder's async log parser already understands
// response.output_text.delta (content) and response.completed (usage), so
// logging works without changes.
interface ToolCallState {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  argsBuf: string;
}

export class ChatToResponsesSseTransform extends Transform {
  private buffer = "";
  private readonly respId: string;
  private readonly msgId: string;
  private readonly model: string;
  private started = false;
  private finished = false;
  private messageOpened = false;
  private messageOutputIndex = 0;
  private nextOutputIndex = 0;
  private textBuf = "";
  private usage: any = null;
  // Ordered by Chat tool_call index. output_index is assigned on first seen.
  private toolCalls = new Map<number, ToolCallState>();

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
  }

  // Open the assistant message item + output_text part lazily, on first
  // text delta. Returns the message's output_index.
  private ensureMessageOpen(): number {
    if (this.messageOpened) return this.messageOutputIndex;
    this.messageOpened = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    this.writeEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.messageOutputIndex,
      item: { id: this.msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.writeEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return this.messageOutputIndex;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;

    // Close the message item if it was opened.
    if (this.messageOpened) {
      this.writeEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.msgId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.textBuf,
      });
      this.writeEvent("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.msgId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textBuf },
      });
      this.writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.messageOutputIndex,
        item: {
          id: this.msgId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: this.textBuf }],
        },
      });
    }

    // Close each function_call item, in output_index order.
    const ordered = [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const tc of ordered) {
      this.writeEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: tc.itemId,
        output_index: tc.outputIndex,
        arguments: tc.argsBuf,
      });
      this.writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: tc.outputIndex,
        item: {
          id: tc.itemId,
          type: "function_call",
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.argsBuf,
        },
      });
    }

    // Build the final output array in output_index order.
    const output: any[] = [];
    if (this.messageOpened) {
      output.push({
        id: this.msgId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.textBuf }],
      });
    }
    for (const tc of ordered) {
      output.push({
        id: tc.itemId,
        type: "function_call",
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.argsBuf,
      });
    }

    this.writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id: this.respId,
        object: "response",
        status: "completed",
        model: this.model,
        output,
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
      // Text content.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const oi = this.ensureMessageOpen();
        this.textBuf += delta.content;
        this.writeEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: this.msgId,
          output_index: oi,
          content_index: 0,
          delta: delta.content,
        });
      }
      // Tool calls. Chat streams them as delta.tool_calls[{index, id?,
      // function?:{name?, arguments?}}] - the first chunk for an index
      // carries id + name, later chunks carry argument fragments.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc.index !== "number") continue;
          let state = this.toolCalls.get(tc.index);
          if (!state) {
            state = {
              outputIndex: this.nextOutputIndex++,
              itemId: "fc_" + nanoid(24),
              callId: tc.id ?? "",
              name: tc.function?.name ?? "",
              argsBuf: "",
            };
            this.toolCalls.set(tc.index, state);
            this.writeEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: state.outputIndex,
              item: {
                id: state.itemId,
                type: "function_call",
                call_id: state.callId,
                name: state.name,
                arguments: "",
              },
            });
          }
          const argsDelta = tc.function?.arguments;
          if (typeof argsDelta === "string" && argsDelta.length > 0) {
            state.argsBuf += argsDelta;
            this.writeEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: state.itemId,
              output_index: state.outputIndex,
              delta: argsDelta,
            });
          }
        }
      }
    }
    if (chunk?.usage) this.usage = chunk.usage;
  }
}

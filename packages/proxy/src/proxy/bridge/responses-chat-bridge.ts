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
  // Codex also ships Responses-only tool types (namespace, web_search,
  // local_shell, mcp, etc.) that have no Chat Completions equivalent.
  // Mapping them to type:"function" with no name/parameters produces an
  // invalid tool that upstream providers reject with 400. Filter to
  // function-shaped entries only; non-function tools are dropped silently
  // (Codex keeps the request alive even without web_search/namespace).
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t: any) => t && (t.type === undefined || t.type === "function"))
      .map((t: any) => ({
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

// Split a model text blob into reasoning content (inside <think>...</think>)
// and visible text (everything else). The reasoning tag is what some openai
// providers emit around chain-of-thought tokens; Codex's Responses consumer
// wants that surfaced as a `reasoning` output item, not as raw visible text.
// Multiple or malformed tags fall back to "everything outside the first
// balanced pair is visible".
const REASONING_OPEN = "<think>" as const;
const REASONING_CLOSE = "</think>" as const;
function parseReasoning(text: string): { reasoning: string; visible: string } {
  if (!text) return { reasoning: "", visible: "" };
  const openIdx = text.indexOf(REASONING_OPEN);
  if (openIdx === -1) return { reasoning: "", visible: text };
  const closeIdx = text.indexOf(REASONING_CLOSE, openIdx + REASONING_OPEN.length);
  if (closeIdx === -1) {
    // Unbalanced open tag with no close — treat the rest as reasoning,
    // nothing as visible (avoids leaking a half-baked <think> into output).
    return { reasoning: text.slice(openIdx + REASONING_OPEN.length), visible: text.slice(0, openIdx) };
  }
  const reasoning = text.slice(openIdx + REASONING_OPEN.length, closeIdx);
  const visible = text.slice(0, openIdx) + text.slice(closeIdx + REASONING_CLOSE.length);
  return { reasoning, visible };
}

// Convert a non-streaming Chat Completions response into a Responses API
// response object. `<think>...</think>` chunks in the content become a
// `reasoning` output item; the rest of the content goes into a `message`
// output item. Each `tool_calls` entry maps to a `function_call` output
// item. An empty message item is only emitted when there is no tool_calls
// (so a pure tool-call response doesn't carry a redundant empty message).
// Top-level `output_text` aggregates visible text across message items so
// callers that read it as a convenience field (OpenAI Responses SDK) get
// the same value the model intended.
export function chatResponseToResponses(body: any, respId: string): any {
  const choice = body?.choices?.[0];
  const msg = choice?.message ?? {};
  const rawText = typeof msg.content === "string" ? msg.content : "";
  const { reasoning, visible } = parseReasoning(rawText);
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const output: any[] = [];
  if (reasoning) {
    output.push({
      id: "rs_" + nanoid(24),
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoning }],
      content: [{ type: "reasoning_text", text: reasoning }],
      status: "completed",
    });
  }
  if (visible || (toolCalls.length === 0 && !reasoning)) {
    output.push({
      id: "msg_" + nanoid(24),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: visible, annotations: [] }],
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

  const outputText = output
    .filter((o) => o.type === "message")
    .flatMap((o: any) => (o.content ?? []).filter((p: any) => p.type === "output_text").map((p: any) => p.text))
    .join("");

  return {
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body?.model ?? "",
    output,
    output_text: outputText,
    usage: mapUsage(body?.usage),
  };
}

// Streaming transform: consumes Chat Completions SSE bytes, emits Responses
// SSE bytes. Handles reasoning text (<think>...</think> chunks in the chat
// content), visible text, and tool calls:
//   - reasoning deltas  -> response.reasoning_summary_text.delta
//   - visible deltas    -> response.output_text.delta
//   - tool_call deltas  -> response.output_item.added (function_call) +
//     response.function_call_arguments.delta
// On finish: closes the reasoning item (if any), closes the message item
// (if any), closes each function_call item, then response.completed.
//
// The reasoning item is opened lazily on the first <think> marker and the
// message item is opened lazily on the first visible text delta. output_index
// is assigned in arrival order across all item types. Reasoning comes before
// the message in the output array, matching the OpenAI Responses order.
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

type StreamMode = "pre" | "visible" | "thinking";

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

  // Reasoning state. The <think> / </think> markers can straddle chunk
  // boundaries, so we keep a small backtrack tail to disambiguate "think"
  // (visible text) from "think<..." (opening marker).
  private mode: StreamMode = "pre";
  private tail = "";
  private reasoningOpened = false;
  // True once a reasoning item has been fully closed. Used to decide
  // whether the final response.completed should carry a reasoning item
  // (independent of `reasoningOpened`, which flips false on close so a
  // second close attempt is a no-op).
  private reasoningEmitted = false;
  private reasoningItemId = "";
  private reasoningOutputIndex = 0;
  private reasoningBuf = "";
  private createdAt = 0;

  constructor(model: string) {
    super();
    this.respId = "resp_" + nanoid(24);
    this.msgId = "msg_" + nanoid(24);
    this.model = model ?? "";
    this.createdAt = Math.floor(Date.now() / 1000);
  }

  private writeEvent(eventType: string, data: any): void {
    this.push(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.writeEvent("response.created", {
      type: "response.created",
      response: {
        id: this.respId,
        object: "response",
        created_at: this.createdAt,
        status: "in_progress",
        model: this.model,
        output: [],
      },
    });
  }

  // Open the assistant message item + output_text part lazily, on first
  // visible text delta. Returns the message's output_index.
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

  // Open the reasoning item + first summary_text part. Called the first
  // time a <think> marker is consumed.
  private openReasoningItem(): void {
    this.reasoningOpened = true;
    this.reasoningItemId = "rs_" + nanoid(24);
    this.reasoningOutputIndex = this.nextOutputIndex++;
    this.reasoningBuf = "";
    this.writeEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.reasoningOutputIndex,
      item: {
        id: this.reasoningItemId,
        type: "reasoning",
        summary: [],
        content: null,
        status: "in_progress",
      },
    });
    this.writeEvent("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  }

  private closeReasoningItem(): void {
    if (!this.reasoningOpened) return;
    this.reasoningOpened = false;
    this.reasoningEmitted = true;
    this.writeEvent("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoningBuf,
    });
    this.writeEvent("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: this.reasoningBuf },
    });
    this.writeEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.reasoningOutputIndex,
      item: {
        id: this.reasoningItemId,
        type: "reasoning",
        summary: [{ type: "summary_text", text: this.reasoningBuf }],
        content: null,
        status: "completed",
      },
    });
  }

  // Emit a visible text delta. Opens the message item lazily.
  private emitVisibleDelta(text: string): void {
    if (!text) return;
    const oi = this.ensureMessageOpen();
    this.textBuf += text;
    this.writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.msgId,
      output_index: oi,
      content_index: 0,
      delta: text,
    });
  }

  // Emit a reasoning text delta. The reasoning item is already open here.
  private emitReasoningDelta(text: string): void {
    if (!text) return;
    this.reasoningBuf += text;
    this.writeEvent("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  // Find the longest prefix of `marker` that matches a suffix of `text`.
  // Used to hold back a partial tag (e.g. "thin" might be the start of
  // "<think>") until the next chunk confirms or denies.
  private static matchingPrefixSuffix(marker: string, text: string): number {
    const max = Math.min(marker.length, text.length);
    for (let len = max; len > 0; len--) {
      if (text.endsWith(marker.slice(0, len))) return len;
    }
    return 0;
  }

  // Process a chunk of chat text. Splits it into reasoning and visible
  // segments on <think>...</think> boundaries. Tail buffer holds back
  // a possible partial tag until the next chunk arrives.
  private processText(text: string): void {
    this.tail += text;
    while (this.tail) {
      if (this.mode === "pre" || this.mode === "visible") {
        const idx = this.tail.indexOf(REASONING_OPEN);
        if (idx === -1) {
          const held = ChatToResponsesSseTransform.matchingPrefixSuffix(REASONING_OPEN, this.tail);
          if (held === 0) {
            this.emitVisibleDelta(this.tail);
            this.tail = "";
          } else if (held < this.tail.length) {
            this.emitVisibleDelta(this.tail.slice(0, this.tail.length - held));
            this.tail = this.tail.slice(-held);
          } else {
            // Whole tail is a held-back prefix of the open marker; wait
            // for more input before flushing.
            break;
          }
        } else {
          this.emitVisibleDelta(this.tail.slice(0, idx));
          this.tail = this.tail.slice(idx + REASONING_OPEN.length);
          this.openReasoningItem();
          this.mode = "thinking";
        }
      } else {
        const idx = this.tail.indexOf(REASONING_CLOSE);
        if (idx === -1) {
          const held = ChatToResponsesSseTransform.matchingPrefixSuffix(REASONING_CLOSE, this.tail);
          if (held === 0) {
            this.emitReasoningDelta(this.tail);
            this.tail = "";
          } else if (held < this.tail.length) {
            this.emitReasoningDelta(this.tail.slice(0, this.tail.length - held));
            this.tail = this.tail.slice(-held);
          } else {
            // Whole tail is a held-back prefix of the close marker; wait
            // for more input before flushing.
            break;
          }
        } else {
          this.emitReasoningDelta(this.tail.slice(0, idx));
          this.tail = this.tail.slice(idx + REASONING_CLOSE.length);
          this.closeReasoningItem();
          this.mode = "visible";
        }
      }
    }
  }

  // Flush any held-back tail text. At end of stream a partial <think>
  // prefix or </think> prefix can no longer resolve into a real tag, so
  // the held text is emitted under the current mode (visible or thinking).
  private flushTail(): void {
    if (!this.tail) return;
    if (this.mode === "thinking") {
      this.emitReasoningDelta(this.tail);
    } else {
      this.emitVisibleDelta(this.tail);
    }
    this.tail = "";
  }

  private finish(): void {
    if (this.finished) return;
    this.flushTail();
    if (this.reasoningOpened) this.closeReasoningItem();
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
          content: [{ type: "output_text", text: this.textBuf, annotations: [] }],
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

    // Build the final output array in output_index order so reasoning,
    // message, and tool_calls all land in the order they were streamed.
    const items: Array<{ idx: number; item: any }> = [];
    if (this.reasoningEmitted) {
      items.push({
        idx: this.reasoningOutputIndex,
        item: {
          id: this.reasoningItemId,
          type: "reasoning",
          summary: [{ type: "summary_text", text: this.reasoningBuf }],
          content: null,
          status: "completed",
        },
      });
    }
    if (this.messageOpened) {
      items.push({
        idx: this.messageOutputIndex,
        item: {
          id: this.msgId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: this.textBuf, annotations: [] }],
        },
      });
    }
    for (const tc of ordered) {
      items.push({
        idx: tc.outputIndex,
        item: {
          id: tc.itemId,
          type: "function_call",
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.argsBuf,
        },
      });
    }
    items.sort((a, b) => a.idx - b.idx);
    const output = items.map((x) => x.item);

    this.writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id: this.respId,
        object: "response",
        created_at: this.createdAt,
        status: "completed",
        model: this.model,
        output,
        output_text: this.textBuf,
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
      // Text content. Routed through the <think>/</think> splitter so
      // chain-of-thought chunks become a `reasoning` item.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.processText(delta.content);
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

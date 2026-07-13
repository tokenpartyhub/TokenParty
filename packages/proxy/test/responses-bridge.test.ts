import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Readable } from "node:stream";
import { _setConfigForTest } from "../src/config.js";
import { initDb } from "../src/store/db.js";
import { createServer } from "../src/server.js";
import type { Config } from "../src/types/config.js";
import {
  responsesRequestToChat,
  chatResponseToResponses,
  ChatToResponsesSseTransform,
  needsResponsesBridge,
} from "../src/proxy/bridge/responses-chat-bridge.js";

// --- pure-function unit tests ---

describe("responsesRequestToChat (text-only)", () => {
  it("converts input string to a user message", () => {
    const out = responsesRequestToChat({ model: "m", input: "hello" });
    assert.deepEqual(out.messages, [{ role: "user", content: "hello" }]);
    assert.equal(out.model, "m");
  });

  it("converts instructions to a leading system message", () => {
    const out = responsesRequestToChat({ model: "m", instructions: "be brief", input: "hi" });
    assert.deepEqual(out.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts input array of message items, joining text parts", () => {
    const out = responsesRequestToChat({
      model: "m",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "perm" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }] },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "developer", content: "perm" },
      { role: "user", content: "ab" },
    ]);
  });

  it("maps max_output_tokens -> max_tokens and passes through stream/temperature/top_p", () => {
    const out = responsesRequestToChat({ model: "m", input: "x", stream: true, temperature: 0.5, top_p: 0.9, max_output_tokens: 123 });
    assert.equal(out.max_tokens, 123);
    assert.equal(out.stream, true);
    assert.equal(out.temperature, 0.5);
    assert.equal(out.top_p, 0.9);
  });

  it("converts tools / tool_choice / parallel_tool_calls / reasoning_effort", () => {
    const out = responsesRequestToChat({
      model: "m", input: "x",
      tools: [{ type: "function", name: "exec", description: "run", parameters: { type: "object" }, strict: false }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      store: false,
    });
    assert.deepEqual(out.tools, [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object" }, strict: false } }]);
    assert.equal(out.tool_choice, "auto");
    assert.equal(out.parallel_tool_calls, false);
    assert.equal(out.reasoning_effort, "medium");
    // store has no Chat equivalent - dropped
    assert.equal(out.store, undefined);
  });

  it("drops Responses-only tool types (namespace / web_search / etc.)", () => {
    // Codex sends these alongside function tools. Chat Completions has no
    // equivalent and upstream providers reject them with 400 if we naively
    // convert. Filtering here keeps the valid function tools and silently
    // drops the rest so Codex's request still goes through.
    const out = responsesRequestToChat({
      model: "m", input: "x",
      tools: [
        { type: "function", name: "exec", parameters: {} },
        { type: "web_search", external_web_access: false },
        { type: "namespace", name: "multi_agent_v1", tools: [] },
        { type: "local_shell" },
      ],
    });
    assert.deepEqual(out.tools, [{ type: "function", function: { name: "exec", parameters: {} } }]);
  });

  it("converts function_call / function_call_output input items to assistant tool_calls + tool messages", () => {
    const out = responsesRequestToChat({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: "exec", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "c1", output: "file1\n" },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: '{"cmd":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file1\n" },
    ]);
  });

  it("merges consecutive function_call items into one assistant message (parallel tool calls)", () => {
    const out = responsesRequestToChat({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "exec", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "read", arguments: "{}" },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "assistant");
    assert.equal(out.messages[0].tool_calls.length, 2);
    assert.deepEqual(out.messages[0].tool_calls.map((t: any) => t.id), ["c1", "c2"]);
  });
});

describe("chatResponseToResponses (non-streaming)", () => {
  it("converts choices[0].message.content to an output_text message", () => {
    const out = chatResponseToResponses(
      { model: "m", choices: [{ message: { content: "hello" } }] },
      "resp_123",
    );
    assert.equal(out.id, "resp_123");
    assert.equal(out.object, "response");
    assert.equal(out.status, "completed");
    assert.equal(out.output[0].type, "message");
    assert.equal(out.output[0].role, "assistant");
    assert.equal(out.output[0].content[0].type, "output_text");
    assert.equal(out.output[0].content[0].text, "hello");
  });

  it("maps chat usage to responses usage shape", () => {
    const out = chatResponseToResponses(
      {
        model: "m",
        choices: [{ message: { content: "x" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } },
      },
      "resp_1",
    );
    assert.equal(out.usage.input_tokens, 5);
    assert.equal(out.usage.output_tokens, 3);
    assert.equal(out.usage.total_tokens, 8);
    assert.equal(out.usage.cache_read_input_tokens, 2);
  });

  it("handles missing content and missing usage gracefully", () => {
    const out = chatResponseToResponses({ model: "m", choices: [{ message: {} }] }, "resp_1");
    assert.equal(out.output[0].content[0].text, "");
    assert.equal(out.usage.input_tokens, 0);
  });

  it("converts tool_calls to function_call output items (no empty message)", () => {
    const out = chatResponseToResponses(
      {
        model: "m",
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
      "resp_1",
    );
    // No text -> no message item, only the function_call.
    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, "function_call");
    assert.equal(out.output[0].call_id, "call_1");
    assert.equal(out.output[0].name, "exec_command");
    assert.equal(out.output[0].arguments, '{"cmd":"ls"}');
    assert.equal(out.usage.input_tokens, 10);
  });

  it("emits both message and function_call items for mixed text + tool_calls", () => {
    const out = chatResponseToResponses(
      {
        model: "m",
        choices: [{
          message: {
            content: "Running it.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }],
          },
        }],
      },
      "resp_1",
    );
    assert.equal(out.output.length, 2);
    assert.equal(out.output[0].type, "message");
    assert.equal(out.output[0].content[0].text, "Running it.");
    assert.equal(out.output[1].type, "function_call");
    assert.equal(out.output[1].name, "exec");
  });

  it("splits <think>...</think> content into a reasoning item followed by a message item", () => {
    const out = chatResponseToResponses(
      {
        model: "m",
        choices: [{ message: { content: "<think>The user wants a greeting.</think>Hello there!" } }],
      },
      "resp_1",
    );
    assert.equal(out.output.length, 2);

    const reasoning = out.output[0];
    assert.equal(reasoning.type, "reasoning");
    assert.equal(reasoning.status, "completed");
    assert.equal(reasoning.summary.length, 1);
    assert.equal(reasoning.summary[0].type, "summary_text");
    assert.equal(reasoning.summary[0].text, "The user wants a greeting.");
    assert.equal(reasoning.content.length, 1);
    assert.equal(reasoning.content[0].type, "reasoning_text");
    assert.equal(reasoning.content[0].text, "The user wants a greeting.");

    const message = out.output[1];
    assert.equal(message.type, "message");
    assert.equal(message.content[0].type, "output_text");
    assert.equal(message.content[0].text, "Hello there!");
    assert.deepEqual(message.content[0].annotations, []);
  });

  it("reasoning-only content: emits reasoning item but no message", () => {
    const out = chatResponseToResponses(
      { model: "m", choices: [{ message: { content: "<think>just thinking</think>" } }] },
      "resp_1",
    );
    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, "reasoning");
    assert.equal(out.output[0].summary[0].text, "just thinking");
  });

  it("top-level output_text aggregates visible text across message items", () => {
    const out = chatResponseToResponses(
      { model: "m", choices: [{ message: { content: "<think>thinking</think>visible answer" } }] },
      "resp_1",
    );
    assert.equal(out.output_text, "visible answer");
    assert.equal(typeof out.created_at, "number");
    assert.ok(out.created_at > 1_700_000_000);
  });

  it("reasoning with tool_call: reasoning item, no message, then function_call", () => {
    const out = chatResponseToResponses(
      {
        model: "m",
        choices: [{
          message: {
            content: "<think>plan</think>",
            tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: "{}" } }],
          },
        }],
      },
      "resp_1",
    );
    assert.equal(out.output.length, 2);
    assert.equal(out.output[0].type, "reasoning");
    assert.equal(out.output[1].type, "function_call");
    assert.equal(out.output_text, "");
  });
});

// --- SSE transform unit test ---

// Parse `event: t\ndata: {...}\n\n` blocks into [{event, data}].
function parseSse(text: string): { event: string; data: any }[] {
  const events: { event: string; data: any }[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (event && dataLines.length) {
      try { events.push({ event, data: JSON.parse(dataLines.join("\n")) }); } catch {}
    }
  }
  return events;
}

describe("ChatToResponsesSseTransform", () => {
  it("emits created -> deltas -> completed with accumulated text and usage", async () => {
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);

    const types = events.map((e) => e.event);
    assert.ok(types.includes("response.created"));
    assert.ok(types.includes("response.output_text.delta"));
    assert.ok(types.includes("response.completed"));

    const deltas = events.filter((e) => e.event === "response.output_text.delta");
    assert.equal(deltas.reduce((s, e) => s + e.data.delta, ""), "Hello world");

    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.usage.input_tokens, 5);
    assert.equal(completed.data.response.usage.output_tokens, 2);
    assert.equal(completed.data.response.output[0].content[0].text, "Hello world");
  });

  it("finishes on stream end even without [DONE]", async () => {
    const input = `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`;
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);
    assert.ok(events.some((e) => e.event === "response.completed"));
    assert.equal(events.find((e) => e.event === "response.output_text.delta")?.data.delta, "x");
  });

  it("emits function_call output_item + arguments delta/done for tool_call deltas", async () => {
    // A pure tool-call response (no text): no message item should be opened.
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec", arguments: "" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "cmd\":\"ls\"}" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);
    const byType: Record<string, any[]> = {};
    for (const e of events) {
      (byType[e.event] ??= []).push(e.data);
    }

    // No message item for pure tool-call streams.
    assert.equal(byType["response.output_item.added"]?.length, 1);
    assert.equal(byType["response.output_item.added"][0].item.type, "function_call");
    assert.equal(byType["response.output_item.added"][0].item.name, "exec");
    assert.equal(byType["response.output_item.added"][0].item.call_id, "call_abc");

    // Arguments accumulated from the deltas.
    const argDeltas = (byType["response.function_call_arguments.delta"] ?? []).map((d) => d.delta).join("");
    assert.equal(argDeltas, '{"cmd":"ls"}');

    // Closing events.
    const argDone = byType["response.function_call_arguments.done"]?.[0];
    assert.equal(argDone?.arguments, '{"cmd":"ls"}');
    const itemDone = byType["response.output_item.done"]?.[0];
    assert.equal(itemDone?.item.type, "function_call");
    assert.equal(itemDone?.item.arguments, '{"cmd":"ls"}');

    // response.completed output should contain just the function_call (no message).
    const completed = byType["response.completed"]?.[0];
    assert.equal(completed.response.output.length, 1);
    assert.equal(completed.response.output[0].type, "function_call");
    assert.equal(completed.response.usage.input_tokens, 6);
  });

  it("splits <think>...</think> into a reasoning item + visible message", async () => {
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "<think>" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "thinking " } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "step" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "</think>" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi!" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);
    const byType: Record<string, any[]> = {};
    for (const e of events) (byType[e.event] ??= []).push(e.data);

    // Reasoning item is opened with the right shape.
    const addedItems = byType["response.output_item.added"];
    assert.equal(addedItems.length, 2);
    const reasoningAdd = addedItems.find((d) => d.item.type === "reasoning");
    const messageAdd = addedItems.find((d) => d.item.type === "message");
    assert.ok(reasoningAdd);
    assert.ok(messageAdd);
    assert.equal(reasoningAdd.item.type, "reasoning");
    assert.equal(reasoningAdd.item.status, "in_progress");
    assert.deepEqual(reasoningAdd.item.summary, []);
    assert.equal(reasoningAdd.item.content, null);

    // summary_text deltas accumulate, and a summary_part.added opens the part.
    assert.equal(byType["response.reasoning_summary_part.added"]?.length, 1);
    const reasoningDeltas = (byType["response.reasoning_summary_text.delta"] ?? []).map((d) => d.delta).join("");
    assert.equal(reasoningDeltas, "thinking step");
    const reasoningDone = byType["response.reasoning_summary_text.done"]?.[0];
    assert.equal(reasoningDone?.text, "thinking step");
    assert.equal(byType["response.reasoning_summary_part.done"]?.[0]?.part.text, "thinking step");

    // Visible text only lands in the message stream.
    const messageDeltas = (byType["response.output_text.delta"] ?? []).map((d) => d.delta).join("");
    assert.equal(messageDeltas, "Hi!");

    // reasoning item closes before the message item closes.
    const doneItems = byType["response.output_item.done"];
    const reasoningDoneItem = doneItems.find((d) => d.item.type === "reasoning");
    const messageDoneItem = doneItems.find((d) => d.item.type === "message");
    assert.equal(reasoningDoneItem.item.summary[0].text, "thinking step");
    assert.equal(reasoningDoneItem.item.status, "completed");
    assert.equal(messageDoneItem.item.content[0].text, "Hi!");

    // Final response carries both items in output_index order with
    // top-level output_text aggregating only visible text.
    const completed = byType["response.completed"][0];
    assert.equal(completed.response.output.length, 2);
    assert.equal(completed.response.output[0].type, "reasoning");
    assert.equal(completed.response.output[0].summary[0].text, "thinking step");
    assert.equal(completed.response.output[1].type, "message");
    assert.equal(completed.response.output[1].content[0].text, "Hi!");
    assert.equal(completed.response.output_text, "Hi!");
    assert.equal(typeof completed.response.created_at, "number");
  });

  it("handles <think> split across chunk boundaries (partial open marker)", async () => {
    // The first chunk ends with a prefix of the <think> marker ("<thin")
    // and the second chunk completes it ("k>secret</think>"). The tail
    // buffer must hold back "<thin" and not emit it as visible text.
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<thin" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "k>secret</think>" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);
    const byType: Record<string, any[]> = {};
    for (const e of events) (byType[e.event] ??= []).push(e.data);

    const reasoningDeltas = (byType["response.reasoning_summary_text.delta"] ?? []).map((d) => d.delta).join("");
    assert.equal(reasoningDeltas, "secret");
    const messageDeltas = (byType["response.output_text.delta"] ?? []).map((d) => d.delta).join("");
    assert.equal(messageDeltas, "world");
  });

  it("flushes held-back text as visible when stream ends inside a possible marker", async () => {
    // "think" is never followed by "<" + content; the held-back suffix
    // must flush as visible text at end of stream.
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "think about it" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const transform = new ChatToResponsesSseTransform("m");
    const output = await Readable.from(input).pipe(transform).toArray();
    const text = Buffer.concat(output.map((b: any) => Buffer.from(b))).toString("utf-8");
    const events = parseSse(text);
    const messageDeltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
    assert.equal(messageDeltas, "think about it");
  });
});

// --- integration via the real server ---

class MockUpstream {
  received: Array<{ path: string; method: string; body: string }> = [];
  server: http.Server;
  port = 0;
  // Handler returns {status, headers, body} where body may be a string
  // (written verbatim, for SSE) or an object (JSON-encoded).
  handler: (req: http.IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body: any };

  constructor(handler: MockUpstream["handler"]) {
    this.handler = handler;
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        this.received.push({ path: req.url ?? "/", method: req.method ?? "?", body });
        const r = this.handler(req, body);
        const out = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(out);
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  url(p: string): string { return `http://127.0.0.1:${this.port}${p}`; }
  async close(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}

// Streaming variant: the handler writes SSE chunks then ends.
class StreamingMockUpstream {
  received: Array<{ path: string; body: string }> = [];
  server: http.Server;
  port = 0;
  chunks: string[];
  constructor(chunks: string[]) { this.chunks = chunks; this.server = http.createServer(this.handle); }
  handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      this.received.push({ path: req.url ?? "/", body: Buffer.concat(chunks).toString("utf-8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of this.chunks) res.write(c);
      res.end();
    });
  };
  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  url(p: string): string { return `http://127.0.0.1:${this.port}${p}`; }
  async close(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}

function makeBridgedConfig(upstreamUrl: string, dataDir: string): Config {
  return {
    server: {
      port: 0, host: "127.0.0.1",
      logDir: path.join(dataDir, "logs"), dataDir,
      upstreamTimeoutMs: 30_000, streamingUpstreamTimeoutMs: 300_000,
    },
    providers: [
      {
        id: "bridged", type: "openai", name: "bridged",
        apiKey: "sk-test", baseUrl: upstreamUrl,
        models: [{ id: "test-model", priority: 1 }],
        enabled: true, group: "default", currency: "USD",
        responsesToChat: true,
      },
    ],
    tokens: [{ key: "tp-test", name: "tester", allowedProviders: ["*"], enabled: true }],
  };
}

describe("integration: /v1/responses -> /chat/completions bridge", () => {
  let app: ReturnType<typeof createServer>;

  it("needsResponsesBridge: only openai + responsesToChat + responses entry", () => {
    assert.equal(needsResponsesBridge({ type: "openai", responsesToChat: true } as any, true), true);
    assert.equal(needsResponsesBridge({ type: "openai", responsesToChat: true } as any, false), false);
    assert.equal(needsResponsesBridge({ type: "openai", responsesToChat: false } as any, true), false);
    assert.equal(needsResponsesBridge({ type: "anthropic", responsesToChat: true } as any, true), false);
  });

  it("non-streaming: converts request to /chat/completions and response back to Responses", async () => {
    const upstream = new MockUpstream((_req, _body) => ({
      status: 200,
      body: {
        model: "test-model",
        choices: [{ message: { content: "hi there" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    }));
    await upstream.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-bridge-"));
    _setConfigForTest(makeBridgedConfig(upstream.url("/v1"), dataDir));
    initDb();
    app = createServer();
    try {
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", instructions: "be brief", input: "hello", stream: false }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, "response");
      assert.equal(body.status, "completed");
      assert.equal(body.output[0].content[0].text, "hi there");
      assert.equal(body.usage.input_tokens, 3);
      assert.equal(body.usage.output_tokens, 2);

      // upstream received /chat/completions with a messages body (not input)
      assert.equal(upstream.received[0].path, "/v1/chat/completions");
      const sent = JSON.parse(upstream.received[0].body);
      assert.ok(Array.isArray(sent.messages));
      assert.equal(sent.input, undefined);
      assert.deepEqual(sent.messages[0], { role: "system", content: "be brief" });
      assert.deepEqual(sent.messages[1], { role: "user", content: "hello" });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      await upstream.close();
    }
  });

  it("streaming: converts chat SSE chunks to Responses SSE events", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const upstream = new StreamingMockUpstream(sseChunks);
    await upstream.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-bridge-"));
    _setConfigForTest(makeBridgedConfig(upstream.url("/v1"), dataDir));
    initDb();
    app = createServer();
    try {
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", input: "hi", stream: true }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = await res.text();
      const events = parseSse(text);
      const types = events.map((e) => e.event);
      assert.ok(types.includes("response.created"));
      assert.ok(types.includes("response.output_text.delta"));
      assert.ok(types.includes("response.completed"));
      const deltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
      assert.equal(deltas, "Hello");
      const completed = events.find((e) => e.event === "response.completed");
      assert.equal(completed.data.response.usage.input_tokens, 4);

      // upstream got /chat/completions with stream_options.include_usage
      assert.equal(upstream.received[0].path, "/v1/chat/completions");
      const sent = JSON.parse(upstream.received[0].body);
      assert.equal(sent.stream, true);
      assert.deepEqual(sent.stream_options, { include_usage: true });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      await upstream.close();
    }
  });

  it("non-streaming: upstream content with <think>...</think> is split into reasoning + message items", async () => {
    const upstream = new MockUpstream((_req, _body) => ({
      status: 200,
      body: {
        model: "test-model",
        choices: [{ message: { content: "<think>plan</think>final answer" } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      },
    }));
    await upstream.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-bridge-"));
    _setConfigForTest(makeBridgedConfig(upstream.url("/v1"), dataDir));
    initDb();
    app = createServer();
    try {
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", input: "hi", stream: false }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.output.length, 2);
      assert.equal(body.output[0].type, "reasoning");
      assert.equal(body.output[0].summary[0].text, "plan");
      assert.equal(body.output[0].content[0].text, "plan");
      assert.equal(body.output[1].type, "message");
      assert.equal(body.output[1].content[0].text, "final answer");
      assert.equal(body.output_text, "final answer");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      await upstream.close();
    }
  });

  it("streaming: upstream <think> chunks surface as reasoning_summary deltas, not visible text", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "<think>" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "I think" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "</think>" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello!" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const upstream = new StreamingMockUpstream(sseChunks);
    await upstream.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-bridge-"));
    _setConfigForTest(makeBridgedConfig(upstream.url("/v1"), dataDir));
    initDb();
    app = createServer();
    try {
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", input: "hi", stream: true }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const events = parseSse(text);
      const byType: Record<string, any[]> = {};
      for (const e of events) (byType[e.event] ??= []).push(e.data);

      // No "<think>" leaks into visible text.
      const visible = (byType["response.output_text.delta"] ?? []).map((d) => d.delta).join("");
      assert.equal(visible, "Hello!");

      // Reasoning deltas carry the thinking content.
      const reasoning = (byType["response.reasoning_summary_text.delta"] ?? []).map((d) => d.delta).join("");
      assert.equal(reasoning, "I think");

      // Final response splits cleanly into reasoning + message items.
      const completed = byType["response.completed"][0];
      assert.equal(completed.response.output.length, 2);
      assert.equal(completed.response.output[0].type, "reasoning");
      assert.equal(completed.response.output[0].summary[0].text, "I think");
      assert.equal(completed.response.output[1].type, "message");
      assert.equal(completed.response.output[1].content[0].text, "Hello!");
      assert.equal(completed.response.output_text, "Hello!");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      await upstream.close();
    }
  });
});

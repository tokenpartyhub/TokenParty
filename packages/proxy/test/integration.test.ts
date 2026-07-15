import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { _setConfigForTest } from "../src/config.js";
import { initDb } from "../src/store/db.js";
import { createServer } from "../src/server.js";
import type { Config } from "../src/types/config.js";

// Mock upstream HTTP server. Pops a scripted response per request —
// caller decides the sequence ahead of time.
class MockUpstream {
  responses: Array<{ status: number; body?: any; headers?: Record<string, string> }>;
  received: Array<{ path: string; method: string; body: string }> = [];
  server: http.Server;
  port = 0;

  constructor(responses: MockUpstream["responses"]) {
    this.responses = responses;
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        this.received.push({
          path: req.url ?? "/",
          method: req.method ?? "?",
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        const script = this.responses.shift() ?? { status: 500, body: { error: "no scripted response" } };
        const body = typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? {});
        res.writeHead(script.status, { "content-type": "application/json", ...(script.headers ?? {}) });
        res.end(body);
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// Pick a port nothing is listening on (close immediately).
async function unusedPort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function makeConfig(opts: {
  primaryUrl: string;
  backupUrl?: string;
  dataDir: string;
  includeAnthropic?: boolean;
  upstreamTimeoutMs?: number;
  streamingUpstreamTimeoutMs?: number;
}): Config {
  return {
    server: {
      port: 0, host: "127.0.0.1",
      logDir: path.join(opts.dataDir, "logs"), dataDir: opts.dataDir,
      upstreamTimeoutMs: opts.upstreamTimeoutMs ?? 30_000,
      streamingUpstreamTimeoutMs: opts.streamingUpstreamTimeoutMs ?? 300_000,
    },
    providers: [
      {
        id: "primary",
        type: "openai",
        name: "primary",
        apiKey: "sk-test",
        baseUrl: opts.primaryUrl,
        models: [{ id: "test-model", priority: 1 }],
        enabled: true,
        group: "default",
        currency: "USD",
      },
      ...(opts.backupUrl ? [{
        id: "backup",
        type: "openai" as const,
        name: "backup",
        apiKey: "sk-test",
        baseUrl: opts.backupUrl,
        models: [{ id: "test-model", priority: 10 }],
        enabled: true,
        group: "default",
        currency: "USD",
      }] : []),
      ...(opts.includeAnthropic ? [{
        id: "anthropic-only",
        type: "anthropic" as const,
        name: "anthropic",
        apiKey: "sk-test",
        baseUrl: opts.primaryUrl,
        models: [{ id: "claude-test", priority: 1 }],
        enabled: true,
        group: "default",
        currency: "USD",
      }] : []),
    ],
    tokens: [
      { key: "tp-test", name: "tester", allowedProviders: ["*"], enabled: true },
    ],
  };
}

async function setupApp(opts: {
  primaryUrl: string;
  backupUrl?: string;
  includeAnthropic?: boolean;
  upstreamTimeoutMs?: number;
  streamingUpstreamTimeoutMs?: number;
}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-test-"));
  const config = makeConfig({
    primaryUrl: opts.primaryUrl,
    backupUrl: opts.backupUrl,
    dataDir,
    includeAnthropic: opts.includeAnthropic,
    upstreamTimeoutMs: opts.upstreamTimeoutMs,
    streamingUpstreamTimeoutMs: opts.streamingUpstreamTimeoutMs,
  });
  _setConfigForTest(config);
  initDb();
  const app = createServer();
  return {
    app,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

describe("integration: /v1/chat/completions", () => {
  let app: ReturnType<typeof createServer>;
  let cleanup: () => void;
  let upstream: MockUpstream;

  beforeEach(async () => {
    upstream = new MockUpstream([{ status: 200, body: { id: "ok", choices: [{ message: { content: "hi" } }] } }]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/v1") });
    app = ctx.app;
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    cleanup();
    await upstream.close();
  });

  it("401 without Authorization header", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(res.status, 401);
  });

  it("401 with wrong token", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(res.status, 401);
  });

  it("400 for unknown model", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
      body: JSON.stringify({ model: "no-such", messages: [] }),
    });
    assert.equal(res.status, 400);
  });

  it("400 when only anthropic-type providers serve the model", async () => {
    const ctx = await setupApp({ primaryUrl: "http://127.0.0.1:1", includeAnthropic: true });
    try {
      const res = await ctx.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "claude-test", messages: [] }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /\/anthropic/);
    } finally {
      ctx.cleanup();
    }
  });

  it("forwards and returns 200 on success", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.received.length, 1);
    assert.equal(upstream.received[0].path, "/v1/chat/completions");
    const body = await res.json();
    assert.equal(body.id, "ok");
  });

  it("falls back to backup on retryable 429", async () => {
    // primary returns 429, backup returns 200 — proxy should fall through
    const primary = new MockUpstream([{ status: 429, body: { error: "rate limited" } }]);
    const backup = new MockUpstream([{ status: 200, body: { id: "ok-backup", choices: [{ message: { content: "from backup" } }] } }]);
    await primary.listen();
    await backup.listen();
    const ctx = await setupApp({ primaryUrl: primary.url("/v1"), backupUrl: backup.url("/v1") });
    try {
      const res = await ctx.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal(primary.received.length, 1);
      assert.equal(backup.received.length, 1);
      const body = await res.json();
      assert.equal(body.id, "ok-backup");
    } finally {
      ctx.cleanup();
      await primary.close();
      await backup.close();
    }
  });

  it("returns 502 when all candidates fail", async () => {
    const primary = new MockUpstream([{ status: 500, body: { error: "internal" } }]);
    await primary.listen();
    const badPort = await unusedPort();
    const ctx = await setupApp({
      primaryUrl: primary.url("/v1"),
      backupUrl: `http://127.0.0.1:${badPort}/v1`,
    });
    try {
      const res = await ctx.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 502);
    } finally {
      ctx.cleanup();
      await primary.close();
    }
  });
});

describe("integration: /anthropic/v1/messages", () => {
  let app: ReturnType<typeof createServer>;
  let cleanup: () => void;

  afterEach(() => cleanup());

  it("401 without auth headers", async () => {
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/anthropic"), includeAnthropic: true });
    app = ctx.app;
    cleanup = async () => { ctx.cleanup(); await upstream.close(); };

    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-test", messages: [] }),
    });
    assert.equal(res.status, 401);
  });

  it("forwards and returns 200 with anthropic-format body", async () => {
    const upstream = new MockUpstream([{
      status: 200,
      body: {
        id: "msg-1", type: "message", role: "assistant",
        content: [{ type: "text", text: "from claude" }],
        stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 },
      },
    }]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/anthropic"), includeAnthropic: true });
    app = ctx.app;
    cleanup = async () => { ctx.cleanup(); await upstream.close(); };

    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "tp-test",
      },
      body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, "from claude");
    assert.equal(upstream.received[0].path, "/anthropic/v1/messages");
  });

  it("rejects openai-only model with /v1 hint", async () => {
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/v1") });
    app = ctx.app;
    cleanup = async () => { ctx.cleanup(); await upstream.close(); };

    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "tp-test",
      },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /\/v1/);
  });
});

describe("integration: models list endpoints", () => {
  it("GET /v1/models returns OpenAI shape (and Codex `models` field)", async () => {
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/v1") });
    try {
      const res = await ctx.app.request("/v1/models", { headers: { Authorization: "Bearer tp-test" } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data) && body.data.length > 0);
      // Codex 0.144+'s ModelsManager deserializes a struct with a
      // required `models` field — without it the manager logs
      // "missing field `models`" and re-polls every 3 minutes.
      assert.deepEqual(body.models, body.data);
    } finally {
      ctx.cleanup();
      await upstream.close();
    }
  });

  it("GET /v1/models: each ModelInfo matches codex-rs struct fields", async () => {
    // Codex 0.144+'s ModelsManager deserializes each entry into a
    // ModelInfo struct (38 fields, codex-rs/protocol/src/openai_models.rs).
    // Wrong-typed / missing / mis-named fields log
    //   "failed to decode models response: missing field `X`" /
    //   "invalid type: ..." /
    //   "unknown variant `Y`, expected ..."
    // and codex re-polls /v1/models. This test enumerates every field
    // Codex expects so future regressions surface immediately.
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/v1") });
    try {
      const res = await ctx.app.request("/v1/models", { headers: { Authorization: "Bearer tp-test" } });
      const body = await res.json();
      assert.ok(body.models.length > 0, "expected at least one model");
      for (const m of body.models) {
        // Required (no #[serde(default)]) string fields
        assert.equal(typeof m.slug, "string");
        assert.equal(typeof m.display_name, "string");
        assert.equal(typeof m.base_instructions, "string");
        // Option<String> — null or string
        assert.ok(m.description === null || typeof m.description === "string");
        // Option<ReasoningEffort> — null or string
        assert.ok(m.default_reasoning_level === null || typeof m.default_reasoning_level === "string");
        // Vec<ReasoningEffortPreset { effort, description }>
        assert.ok(Array.isArray(m.supported_reasoning_levels));
        for (const lvl of m.supported_reasoning_levels) {
          assert.equal(typeof lvl.effort, "string");
          assert.equal(typeof lvl.description, "string");
        }
        // Required enums (snake_case) — assert valid known values
        assert.ok(["default", "local", "unified_exec", "disabled", "shell_command"].includes(m.shell_type));
        assert.ok(["list", "hide", "none"].includes(m.visibility));
        assert.equal(typeof m.supported_in_api, "boolean");
        // priority: i32 (finite; Infinity JSON-encodes to null which codex rejects)
        assert.equal(typeof m.priority, "number");
        assert.ok(Number.isFinite(m.priority));
        // Vec<String>
        assert.ok(Array.isArray(m.additional_speed_tiers));
        // Vec<ModelServiceTier { id, name, description }>
        assert.ok(Array.isArray(m.service_tiers));
        // Option<String>
        assert.ok(m.default_service_tier === null || typeof m.default_service_tier === "string");
        // Option<ModelAvailabilityNux> — null or { message: string }
        assert.ok(m.availability_nux === null || typeof m.availability_nux?.message === "string");
        // Option<ModelInfoUpgrade> — null or { model: string, migration_markdown: string }
        assert.ok(m.upgrade === null || (typeof m.upgrade?.model === "string" && typeof m.upgrade?.migration_markdown === "string"));
        // Option<ModelMessages> — null or full nested object
        if (m.model_messages !== null) {
          assert.equal(typeof m.model_messages.instructions_template, "string");
          const v = m.model_messages.instructions_variables;
          assert.equal(typeof v, "object");
          for (const k of ["personality_default", "personality_friendly", "personality_pragmatic"]) {
            assert.ok(v[k] === null || typeof v[k] === "string", `model_messages.instructions_variables.${k}`);
          }
          const a = m.model_messages.approvals;
          assert.equal(typeof a, "object");
          for (const k of ["on_request", "on_request_auto_review"]) {
            assert.ok(a[k] === null || typeof a[k] === "string", `model_messages.approvals.${k}`);
          }
        }
        assert.equal(typeof m.include_skills_usage_instructions, "boolean");
        // CRITICAL — Rust field name matches codex-cli 0.144.1
        // (`supports_reasoning_summaries`, plural). Later codex versions
        // renamed to `supports_reasoning_summary_parameter` (singular +
        // "parameter"); if codex is upgraded, rename this too. With
        // `default = default_true` a missing or wrong-name field defaults
        // to true on deserialize, silently changing model capability.
        assert.equal(typeof m.supports_reasoning_summaries, "boolean");
        // ReasoningSummary enum (lowercase)
        assert.ok(["auto", "concise", "detailed", "none"].includes(m.default_reasoning_summary));
        assert.equal(typeof m.support_verbosity, "boolean");
        // Option<Verbosity>
        assert.ok(m.default_verbosity === null || ["low", "medium", "high"].includes(m.default_verbosity));
        // Option<ApplyPatchToolType>
        assert.ok(m.apply_patch_tool_type === null || ["freeform"].includes(m.apply_patch_tool_type));
        // WebSearchToolType (snake_case)
        assert.ok(["text", "text_and_image"].includes(m.web_search_tool_type));
        // TruncationPolicyConfig { mode, limit }
        assert.equal(typeof m.truncation_policy, "object");
        assert.ok(["bytes", "tokens"].includes(m.truncation_policy.mode));
        assert.equal(typeof m.truncation_policy.limit, "number");
        assert.ok(Number.isFinite(m.truncation_policy.limit));
        assert.equal(typeof m.supports_parallel_tool_calls, "boolean");
        assert.equal(typeof m.supports_image_detail_original, "boolean");
        // Option<i64>
        assert.ok(m.context_window === null || Number.isFinite(m.context_window));
        assert.ok(m.max_context_window === null || Number.isFinite(m.max_context_window));
        assert.ok(m.auto_compact_token_limit === null || Number.isFinite(m.auto_compact_token_limit));
        assert.ok(m.comp_hash === null || typeof m.comp_hash === "string");
        // i64 (default 100)
        assert.equal(typeof m.effective_context_window_percent, "number");
        assert.ok(Number.isFinite(m.effective_context_window_percent));
        // Vec<String>
        assert.ok(Array.isArray(m.experimental_supported_tools));
        // Vec<InputModality> (lowercase)
        assert.ok(Array.isArray(m.input_modalities));
        for (const mod of m.input_modalities) {
          assert.ok(["text", "image"].includes(mod), `unknown input_modality: ${mod}`);
        }
        assert.equal(typeof m.supports_search_tool, "boolean");
        assert.equal(typeof m.use_responses_lite, "boolean");
        // Option<String>
        assert.ok(m.auto_review_model_override === null || typeof m.auto_review_model_override === "string");
        // Option<ToolMode> (snake_case) — uses deserialize_optional_model_selector
        // which silently accepts unknown strings as None, so just type-check.
        assert.ok(m.tool_mode === null || typeof m.tool_mode === "string");
        // Option<MultiAgentVersion> (snake_case) — same lenient deserializer
        assert.ok(m.multi_agent_version === null || typeof m.multi_agent_version === "string");
      }
    } finally {
      ctx.cleanup();
      await upstream.close();
    }
  });

  it("GET /anthropic/v1/models returns Anthropic shape", async () => {
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/anthropic"), includeAnthropic: true });
    try {
      const res = await ctx.app.request("/anthropic/v1/models", {
        headers: { "anthropic-version": "2023-06-01", "x-api-key": "tp-test" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.data) && body.data.length > 0);
      assert.equal(body.data[0].type, "model");
    } finally {
      ctx.cleanup();
      await upstream.close();
    }
  });
});

// Mock upstream that hangs without responding. Used for timeout and
// client-disconnect tests. Tracks connections so we can assert the
// socket was closed.
class SlowUpstream {
  connections: { aborted: boolean }[] = [];
  server: http.Server;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const conn = { aborted: false };
      this.connections.push(conn);
      req.on("aborted", () => { conn.aborted = true; });
      // never write a response — just hold the socket open
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("integration: upstream timeout + client disconnect", () => {
  let slow: SlowUpstream;
  let cleanup: () => void;

  afterEach(async () => {
    cleanup();
    await slow?.close();
  });

  it("aborts the upstream request after upstreamTimeoutMs and returns 502", async () => {
    slow = new SlowUpstream();
    await slow.listen();
    const ctx = await setupApp({
      primaryUrl: slow.url("/v1"),
      upstreamTimeoutMs: 500,
      backupUrl: slow.url("/v1"),  // also hangs; just need a candidate list
    });
    cleanup = ctx.cleanup;

    const start = Date.now();
    const res = await ctx.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tp-test" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const elapsed = Date.now() - start;

    assert.equal(res.status, 502);
    assert.ok(elapsed < 5_000, `expected to fail under 5s, took ${elapsed}ms`);
    const body = await res.json();
    assert.match(body.error, /All provider candidates failed/);
  });

  it("aborts the upstream when the client disconnects mid-stream", async () => {
    slow = new SlowUpstream();
    await slow.listen();
    const ctx = await setupApp({
      primaryUrl: slow.url("/anthropic"),
      includeAnthropic: true,
      upstreamTimeoutMs: 60_000, // long, so we can prove the abort is from client
      streamingUpstreamTimeoutMs: 60_000,
    });
    cleanup = ctx.cleanup;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const reqPromise = ctx.app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "tp-test",
      },
      body: JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: controller.signal,
    }).catch((e: any) => e);

    // Give the proxy time to register the request and reach the
    // upstream before the abort fires.
    await new Promise((r) => setTimeout(r, 600));
    // The upstream socket should have been closed by the abort.
    const aborted = slow.connections.filter((c) => c.aborted).length;
    assert.ok(aborted > 0, "expected at least one upstream connection to be aborted on client disconnect");
  });
});
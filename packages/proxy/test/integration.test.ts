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
}): Config {
  return {
    server: { port: 0, host: "127.0.0.1", logDir: path.join(opts.dataDir, "logs"), dataDir: opts.dataDir },
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

async function setupApp(opts: { primaryUrl: string; backupUrl?: string; includeAnthropic?: boolean }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-test-"));
  const config = makeConfig({ primaryUrl: opts.primaryUrl, backupUrl: opts.backupUrl, dataDir, includeAnthropic: opts.includeAnthropic });
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
  it("GET /v1/models returns OpenAI shape", async () => {
    const upstream = new MockUpstream([]);
    await upstream.listen();
    const ctx = await setupApp({ primaryUrl: upstream.url("/v1") });
    try {
      const res = await ctx.app.request("/v1/models", { headers: { Authorization: "Bearer tp-test" } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data) && body.data.length > 0);
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
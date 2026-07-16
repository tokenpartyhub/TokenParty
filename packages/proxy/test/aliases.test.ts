import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, resolveAlias, aliasPoolIsEmpty, findOrphanPoolEntries, listAvailableModels, listAvailableModelsDetailed } from "../src/proxy/router.js";
import { _setConfigForTest } from "../src/config.js";
import type { Config } from "../src/types/config.js";

const ALIAS_CONFIG: Config = {
  server: { port: 3456, host: "0.0.0.0", logDir: "./logs", dataDir: "./data" },
  providers: [
    {
      id: "minimax",
      type: "openai",
      name: "MiniMax",
      apiKey: "sk-test",
      baseUrl: "https://minimax.test/v1",
      models: [
        { id: "MiniMax-M4", priority: 1 },
        { id: "MiniMax-M3", priority: 2 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
    {
      id: "openai-primary",
      type: "openai",
      name: "OpenAI",
      apiKey: "sk-test",
      baseUrl: "https://openai.test/v1",
      models: [
        { id: "gpt-5", priority: 1 },
        { id: "gpt-4o", priority: 5 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
    {
      id: "anthropic-primary",
      type: "anthropic",
      name: "Anthropic",
      apiKey: "sk-test",
      baseUrl: "https://anthropic.test",
      models: [
        { id: "claude-opus-4-6", priority: 1 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
  ],
  tokens: [
    { key: "tp-test", name: "tester", allowedProviders: ["*"], enabled: true },
  ],
  aliases: {
    "minimax-latest": ["MiniMax-M4", "MiniMax-M3"],
    performance: [
      { id: "claude-opus-4-6", priority: 1 },
      { id: "gpt-5", priority: 2 },
    ],
    "daily": ["MiniMax-M3", "gpt-4o"],
    "empty-pool": [],
  },
};

describe("resolveAlias", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("returns pool entries for a known alias", () => {
    const pool = resolveAlias("minimax-latest");
    assert.ok(pool);
    assert.equal(pool.length, 2);
  });

  it("returns null for a non-alias model name", () => {
    assert.equal(resolveAlias("MiniMax-M4"), null);
    assert.equal(resolveAlias("nonexistent"), null);
  });

  it("returns null for an alias with an empty pool", () => {
    assert.equal(resolveAlias("empty-pool"), null);
  });
});

describe("resolveProvider with aliases", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("resolves minimax-latest to the highest-priority model's provider", () => {
    const pool = resolveAlias("minimax-latest")!;
    const r = resolveProvider("minimax-latest", ALIAS_CONFIG.tokens[0], pool);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers.length, 1);
      assert.equal(r.providers[0].id, "minimax");
      assert.ok(r.realModelIds);
      assert.equal(r.realModelIds!.get("minimax"), "MiniMax-M4");
    }
  });

  it("resolves cross-provider pool with correct array-position ordering", () => {
    const pool = resolveAlias("performance")!;
    const r = resolveProvider("performance", ALIAS_CONFIG.tokens[0], pool);
    assert.ok("providers" in r);
    if ("providers" in r) {
      // claude-opus-4-6 is first in array, gpt-5 is second — position = priority
      assert.equal(r.providers[0].id, "anthropic-primary");
      assert.equal(r.providers[1].id, "openai-primary");
      assert.equal(r.realModelIds!.get("anthropic-primary"), "claude-opus-4-6");
      assert.equal(r.realModelIds!.get("openai-primary"), "gpt-5");
    }
  });

  it("resolves multi-provider pool where models are from different providers", () => {
    const pool = resolveAlias("daily")!;
    const r = resolveProvider("daily", ALIAS_CONFIG.tokens[0], pool);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers.length, 2);
      assert.equal(r.providers[0].id, "minimax");
      assert.equal(r.realModelIds!.get("minimax"), "MiniMax-M3");
      assert.equal(r.providers[1].id, "openai-primary");
      assert.equal(r.realModelIds!.get("openai-primary"), "gpt-4o");
    }
  });

  it("returns error when no provider serves any model in the pool", () => {
    const pool = [{ id: "nonexistent-model" }];
    const r = resolveProvider("bad-alias", ALIAS_CONFIG.tokens[0], pool);
    assert.ok("error" in r);
  });

  it("array position overrides explicit priority field", () => {
    // gpt-5 has explicit priority: 1 but is second in array;
    // MiniMax-M3 has no priority but is first — first position wins.
    const pool = ["MiniMax-M3", { id: "gpt-5", priority: 1 }];
    const r = resolveProvider("test", ALIAS_CONFIG.tokens[0], pool);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers[0].id, "minimax");
      assert.equal(r.realModelIds!.get("minimax"), "MiniMax-M3");
      assert.equal(r.providers[1].id, "openai-primary");
      assert.equal(r.realModelIds!.get("openai-primary"), "gpt-5");
    }
  });
});

describe("listAvailableModels with aliases", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("includes alias names alongside real model IDs", () => {
    const models = listAvailableModels(ALIAS_CONFIG.tokens[0]);
    assert.ok(models.includes("minimax-latest"));
    assert.ok(models.includes("performance"));
    assert.ok(models.includes("daily"));
    assert.ok(models.includes("MiniMax-M4"));
    assert.ok(models.includes("gpt-5"));
  });

  it("filters aliases by protocol — openai endpoint excludes anthropic-only aliases", () => {
    const models = listAvailableModelsDetailed(ALIAS_CONFIG.tokens[0], "openai");
    const ids = models.map((m) => m.id);
    // minimax-latest has openai models — should appear
    assert.ok(ids.includes("minimax-latest"));
    // daily has MiniMax-M3 (openai) and gpt-4o (openai) — should appear
    assert.ok(ids.includes("daily"));
    // performance has claude-opus-4-6 (anthropic) and gpt-5 (openai) — should appear (has openai model)
    assert.ok(ids.includes("performance"));
  });

  it("filters aliases by protocol — anthropic endpoint", () => {
    const models = listAvailableModelsDetailed(ALIAS_CONFIG.tokens[0], "anthropic");
    const ids = models.map((m) => m.id);
    // performance has claude-opus-4-6 (anthropic) — should appear
    assert.ok(ids.includes("performance"));
    // minimax-latest has only openai models — should NOT appear
    assert.ok(!ids.includes("minimax-latest"));
    // daily has only openai models — should NOT appear
    assert.ok(!ids.includes("daily"));
  });
});

describe("aliasPoolIsEmpty", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("returns true for an alias key whose pool is []", () => {
    assert.equal(aliasPoolIsEmpty("empty-pool"), true);
  });

  it("returns false for an alias key with a populated pool", () => {
    assert.equal(aliasPoolIsEmpty("minimax-latest"), false);
  });

  it("returns false for a model name that is not an alias at all", () => {
    assert.equal(aliasPoolIsEmpty("gpt-5"), false);
    assert.equal(aliasPoolIsEmpty("nonexistent"), false);
  });
});

describe("resolveProvider error messaging", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("returns 'Alias X has no models' for an empty-pool alias", () => {
    // empty-pool is configured but has [] — caller should see a clear
    // error rather than the misleading "No provider for model: empty-pool".
    const r = resolveProvider("empty-pool", ALIAS_CONFIG.tokens[0]);
    assert.ok("error" in r);
    if ("error" in r) {
      assert.ok(r.error.includes("empty-pool"), `error should name the alias: ${r.error}`);
      assert.ok(r.error.includes("no models"), `error should explain empty pool: ${r.error}`);
    }
  });

  it("returns 'No provider available for alias: X' when all pool entries are orphaned", () => {
    // Pool references models no provider serves. The alias resolves to
    // a non-empty pool but every entry yields zero candidates.
    const ghostPool = [{ id: "ghost-model-1" }, { id: "ghost-model-2" }];
    const r = resolveProvider("bad-alias", ALIAS_CONFIG.tokens[0], ghostPool);
    assert.ok("error" in r);
    if ("error" in r) {
      assert.ok(r.error.includes("bad-alias"));
    }
  });

  it("silently drops orphaned entries and keeps resolvable ones", () => {
    // Mixed pool: one ghost, one real. The router should pick up the real
    // entry and ignore the ghost — no error.
    const mixedPool = [{ id: "ghost-model" }, "gpt-5"];
    const r = resolveProvider("mixed", ALIAS_CONFIG.tokens[0], mixedPool);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers.length, 1);
      assert.equal(r.providers[0].id, "openai-primary");
      assert.equal(r.realModelIds!.get("openai-primary"), "gpt-5");
    }
  });
});

describe("findOrphanPoolEntries", () => {
  beforeEach(() => {
    _setConfigForTest(ALIAS_CONFIG);
  });

  it("returns empty array when every entry is served by an enabled provider", () => {
    assert.deepEqual(findOrphanPoolEntries(["gpt-5", "MiniMax-M4"]), []);
  });

  it("lists ids not served by any enabled provider", () => {
    assert.deepEqual(findOrphanPoolEntries(["gpt-5", "nonexistent-model", "another-ghost"]),
      ["nonexistent-model", "another-ghost"]);
  });

  it("deduplicates repeated orphan ids", () => {
    assert.deepEqual(findOrphanPoolEntries(["ghost", "ghost", "ghost"]), ["ghost"]);
  });

  it("ignores disabled providers", () => {
    // Build a config where the only provider serving "openai-only-model"
    // is disabled; the model should be reported as an orphan.
    const cfg: Config = {
      ...ALIAS_CONFIG,
      providers: ALIAS_CONFIG.providers.map((p) =>
        p.id === "openai-primary" ? { ...p, enabled: false } : p,
      ),
    };
    _setConfigForTest(cfg);
    assert.deepEqual(findOrphanPoolEntries(["gpt-5"]), ["gpt-5"]);
    assert.deepEqual(findOrphanPoolEntries(["MiniMax-M4"]), []); // still served by minimax
  });
});

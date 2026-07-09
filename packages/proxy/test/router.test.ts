import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, listAvailableModels } from "../src/proxy/router.js";
import { _setConfigForTest } from "../src/config.js";
import type { Config } from "../src/types/config.js";

const TEST_CONFIG: Config = {
  server: { port: 3456, host: "0.0.0.0", logDir: "./logs", dataDir: "./data" },
  providers: [
    {
      id: "anthro-primary",
      type: "anthropic",
      name: "primary",
      apiKey: "sk-test",
      baseUrl: "https://example.test/anthropic",
      models: [
        { id: "shared-model", priority: 1 },
        { id: "anthro-only", priority: 1 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
    {
      id: "anthro-backup",
      type: "anthropic",
      name: "backup",
      apiKey: "sk-test",
      baseUrl: "https://backup.test/anthropic",
      models: [
        { id: "shared-model", priority: 10 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
    {
      id: "openai-primary",
      type: "openai",
      name: "openai",
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
      models: [
        { id: "openai-only", priority: 5 },
      ],
      enabled: true,
      group: "default",
      currency: "USD",
    },
  ],
  tokens: [
    { key: "tp-test", name: "tester", allowedProviders: ["*"], enabled: true },
  ],
};

describe("resolveProvider", () => {
  beforeEach(() => {
    _setConfigForTest(TEST_CONFIG);
  });

  it("orders candidates by priority asc, then price asc", () => {
    const r = resolveProvider("shared-model", TEST_CONFIG.tokens[0]);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers.length, 2);
      assert.equal(r.providers[0].id, "anthro-primary");
      assert.equal(r.providers[1].id, "anthro-backup");
    }
  });

  it("returns error for unknown model", () => {
    const r = resolveProvider("nonexistent-model", TEST_CONFIG.tokens[0]);
    assert.deepEqual(r, { error: "No provider available for model: nonexistent-model" });
  });

  it("returns single candidate when only one provider serves the model", () => {
    const r = resolveProvider("anthro-only", TEST_CONFIG.tokens[0]);
    assert.ok("providers" in r);
    if ("providers" in r) {
      assert.equal(r.providers.length, 1);
      assert.equal(r.providers[0].id, "anthro-primary");
    }
  });
});

describe("listAvailableModels", () => {
  beforeEach(() => {
    _setConfigForTest(TEST_CONFIG);
  });

  it("deduplicates model names across providers", () => {
    const models = listAvailableModels(TEST_CONFIG.tokens[0]);
    assert.deepEqual(models.sort(), ["anthro-only", "openai-only", "shared-model"].sort());
  });
});
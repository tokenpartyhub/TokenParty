import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickProviderForEntry } from "../src/proxy/route-picker.js";

describe("pickProviderForEntry", () => {
  const anthropicA = { id: "anthropic-main", type: "anthropic", enabled: true } as const;
  const anthropicB = { id: "anthropic-backup", type: "anthropic", enabled: true } as const;
  const openaiA = { id: "openai-main", type: "openai", enabled: true } as const;
  const openaiB = { id: "openai-backup", type: "openai", enabled: true } as const;

  it("picks the first same-type candidate when list starts with one", () => {
    const r = pickProviderForEntry([anthropicA, anthropicB], "anthropic");
    assert.deepEqual(r, { providers: [anthropicA, anthropicB] });
  });

  it("skips a mismatched-type candidate at the head and uses the next one", () => {
    // Router sorted by priority: anthropic (priority=999) before openai
    // (no priority). /v1 entry must still pick openai-main.
    const r = pickProviderForEntry([anthropicA, openaiA], "openai");
    assert.deepEqual(r, { providers: [openaiA] });
  });

  it("drops mismatched-type entries from the ordered result", () => {
    const r = pickProviderForEntry([anthropicA, openaiA, openaiB], "openai");
    assert.deepEqual(r, { providers: [openaiA, openaiB] });
  });

  it("preserves router-ordered priority among same-type candidates", () => {
    const r = pickProviderForEntry([openaiA, anthropicA, openaiB], "openai");
    assert.deepEqual(r, { providers: [openaiA, openaiB] });
  });

  it("returns 400-style error when no candidate matches the entry", () => {
    const r = pickProviderForEntry([anthropicA], "openai");
    assert.deepEqual(r, {
      error: "Provider 'anthropic-main' is anthropic-only. Use the /anthropic endpoint for anthropic-format providers.",
    });
  });

  it("recommends /v1 when only an openai provider is available from /anthropic", () => {
    const r = pickProviderForEntry([openaiA], "anthropic");
    assert.deepEqual(r, {
      error: "Provider 'openai-main' is openai-only. Use the /v1 endpoint for openai-format providers.",
    });
  });

  it("returns generic no-provider error on empty list", () => {
    const r = pickProviderForEntry([], "openai");
    assert.deepEqual(r, { error: "No provider available for model" });
  });

  it("matches anthropic entry when anthropic provider is at head", () => {
    const r = pickProviderForEntry([anthropicA, openaiA], "anthropic");
    assert.deepEqual(r, { providers: [anthropicA] });
  });
});
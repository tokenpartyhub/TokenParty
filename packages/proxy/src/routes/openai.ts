import { Hono } from "hono";
import { authMiddleware } from "../proxy/auth.js";
import { forwardRequest } from "../proxy/forwarder.js";
import { resolveProvider, listAvailableModels } from "../proxy/router.js";
import type { AppEnv } from "../types/env.js";

export const openaiRoutes = new Hono<AppEnv>();

openaiRoutes.use("/*", authMiddleware);

openaiRoutes.get("/models", (c) => {
  const token = c.get("authToken");
  const models = listAvailableModels(token);
  return c.json({
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      created: 1704067200,
      owned_by: "tokenparty",
    })),
  });
});

// Pick the first candidate whose provider.type matches the entry
// protocol. Cross-protocol is no longer supported, but a model that
// is served by both anthropic- and openai-type providers must still
// pick the one matching this entry — we just skip past mismatched
// candidates instead of failing outright.
function pickProviderForEntry<T extends { id: string; type: string }>(
  candidates: T[],
  entryType: "openai" | "anthropic",
): { provider: T; mismatchedNames: string[] } | { error: string } {
  const matched = candidates.find((p) => p.type === entryType);
  if (matched) {
    const mismatched = candidates.filter((p) => p.type !== entryType).map((p) => p.id);
    return { provider: matched, mismatchedNames: mismatched };
  }
  if (candidates.length === 0) {
    return { error: `No provider available for model` };
  }
  // Recommend the endpoint matching the candidate's type so the user
  // knows which entry URL to switch to.
  const recommendedEndpoint = candidates[0].type === "openai" ? "/v1" : "/anthropic";
  return {
    error: `Provider '${candidates[0].id}' is ${candidates[0].type}-only. Use the ${recommendedEndpoint} endpoint for ${candidates[0].type}-format providers.`,
  };
}

// OpenAI Chat Completions API. Only type=openai upstream providers are
// allowed — cross-protocol fallback to Anthropic upstream is no longer
// supported.
openaiRoutes.post("/chat/completions", async (c) => {
  const token = c.get("authToken");
  const body = await c.req.json();
  const model = body.model;

  const result = resolveProvider(model, token);
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }
  const picked = pickProviderForEntry(result.providers, "openai");
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(c, [picked.provider, ...result.providers.filter((p) => p.id !== picked.provider.id && p.type === "openai")], "/chat/completions");
});

// OpenAI Responses API (used by codex CLI and modern OpenAI SDKs).
openaiRoutes.post("/responses", async (c) => {
  const token = c.get("authToken");
  const body = await c.req.json();
  const model = body.model;

  const result = resolveProvider(model, token);
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }
  const picked = pickProviderForEntry(result.providers, "openai");
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(c, [picked.provider, ...result.providers.filter((p) => p.id !== picked.provider.id && p.type === "openai")], "/responses");
});

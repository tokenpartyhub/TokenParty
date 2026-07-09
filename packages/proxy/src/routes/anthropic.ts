import { Hono, type Context } from "hono";
import { authMiddleware } from "../proxy/auth.js";
import { forwardRequest } from "../proxy/forwarder.js";
import { resolveProvider, listAvailableModels } from "../proxy/router.js";
import type { AppEnv } from "../types/env.js";

export const anthropicRoutes = new Hono<AppEnv>();

anthropicRoutes.use("/*", authMiddleware);

const handleAnthropicModels = (c: Context<AppEnv>) => {
  const token = c.get("authToken");
  const models = listAvailableModels(token);
  const data = models.map((id) => ({
    id,
    type: "model",
    display_name: id,
    created_at: "2024-01-01T00:00:00Z",
  }));
  return c.json({
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
};

anthropicRoutes.get("/v1/models", handleAnthropicModels);
anthropicRoutes.get("/models", handleAnthropicModels);

// Pick the first candidate whose provider.type matches the entry
// protocol. Same logic as in routes/openai.ts — duplicated because
// routes already share `authMiddleware` etc. and an extra shared
// util file isn't worth the indirection.
function pickProviderForEntry<T extends { id: string; type: string }>(
  candidates: T[],
  entryType: "openai" | "anthropic",
): { provider: T } | { error: string } {
  const matched = candidates.find((p) => p.type === entryType);
  if (matched) return { provider: matched };
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

// Anthropic Messages API. Only type=anthropic upstream providers are
// allowed — cross-protocol fallback to OpenAI upstream is no longer
// supported.
anthropicRoutes.post("/v1/messages", async (c) => {
  const token = c.get("authToken");
  const body = await c.req.json();
  const model = body.model;

  const result = resolveProvider(model, token);
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }
  const picked = pickProviderForEntry(result.providers, "anthropic");
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(
    c,
    [picked.provider, ...result.providers.filter((p) => p.id !== picked.provider.id && p.type === "anthropic")],
    "/v1/messages",
  );
});
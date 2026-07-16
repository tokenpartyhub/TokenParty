import { Hono, type Context } from "hono";
import { authMiddleware } from "../proxy/auth.js";
import { forwardRequest } from "../proxy/forwarder.js";
import { resolveProvider, resolveAlias, listAvailableModels } from "../proxy/router.js";
import { pickProviderForEntry } from "../proxy/route-picker.js";
import type { AppEnv } from "../types/env.js";

export const anthropicRoutes = new Hono<AppEnv>();

anthropicRoutes.use("/*", authMiddleware);

const handleAnthropicModels = (c: Context<AppEnv>) => {
  const token = c.get("authToken");
  const models = listAvailableModels(token, "anthropic");
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

// Anthropic Messages API. Only type=anthropic upstream providers are
// allowed — cross-protocol fallback to OpenAI upstream is no longer
// supported.
anthropicRoutes.post("/v1/messages", async (c) => {
  const token = c.get("authToken");
  const body = await c.req.json();
  const model = body.model;

  const aliasEntries = resolveAlias(model);
  const result = resolveProvider(model, token, aliasEntries ?? undefined);
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }
  const picked = pickProviderForEntry(result.providers, "anthropic");
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(c, picked.providers, "/v1/messages", undefined, {
    aliasName: aliasEntries ? model : undefined,
    realModelIds: result.realModelIds,
  });
});

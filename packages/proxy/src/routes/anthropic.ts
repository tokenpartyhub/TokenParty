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
  if (result.providers[0].type !== "anthropic") {
    return c.json({
      error: `Provider '${result.providers[0].id}' is ${result.providers[0].type}-only. Use the /v1 endpoint for OpenAI-format providers.`,
    }, 400);
  }
  return forwardRequest(c, result.providers, "/v1/messages", body);
});

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
  if (result.providers[0].type !== "openai") {
    return c.json({
      error: `Provider '${result.providers[0].id}' is ${result.providers[0].type}-only. Use the /anthropic endpoint for Anthropic-format providers.`,
    }, 400);
  }
  return forwardRequest(c, result.providers, "/chat/completions", body);
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
  if (result.providers[0].type !== "openai") {
    return c.json({
      error: `Provider '${result.providers[0].id}' is ${result.providers[0].type}-only. Use the /anthropic endpoint for Anthropic-format providers.`,
    }, 400);
  }
  return forwardRequest(c, result.providers, "/responses", body);
});

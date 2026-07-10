import { Hono } from "hono";
import { authMiddleware } from "../proxy/auth.js";
import { forwardRequest } from "../proxy/forwarder.js";
import { resolveProvider, listAvailableModels } from "../proxy/router.js";
import { pickProviderForEntry } from "../proxy/route-picker.js";
import type { AppEnv } from "../types/env.js";

export const openaiRoutes = new Hono<AppEnv>();

openaiRoutes.use("/*", authMiddleware);

openaiRoutes.get("/models", (c) => {
  const token = c.get("authToken");
  const models = listAvailableModels(token, "openai");
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
// protocol. See route-picker.ts for full logic.
function pickForOpenAI(candidates: any[]): { providers: any[] } | { error: string } {
  return pickProviderForEntry(candidates, "openai");
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
  const picked = pickForOpenAI(result.providers);
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(c, picked.providers, "/chat/completions");
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
  const picked = pickForOpenAI(result.providers);
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  return forwardRequest(c, picked.providers, "/responses");
});

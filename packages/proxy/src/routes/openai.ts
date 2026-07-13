import { Hono } from "hono";
import { authMiddleware } from "../proxy/auth.js";
import { forwardRequest } from "../proxy/forwarder.js";
import { resolveProvider, listAvailableModelsDetailed, type AvailableModelEntry } from "../proxy/router.js";
import { pickProviderForEntry } from "../proxy/route-picker.js";
import type { AppEnv } from "../types/env.js";

export const openaiRoutes = new Hono<AppEnv>();

openaiRoutes.use("/*", authMiddleware);

// Reasoning effort levels surfaced to clients that introspect /v1/models.
// Codex 0.144+ checks `supported_reasoning_levels` and only enables the
// reasoning selector if it recognises the values — we serve the three
// common tiers; clients can default-select via `default_reasoning_level`.
const SUPPORTED_REASONING_LEVELS = [
  { effort: "low",    description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high",   description: "Greater reasoning depth for complex problems" },
];

// Build the rich OpenAI-shaped model object that Codex 0.144+ expects. The
// fields beyond the legacy four (`id`, `object`, `created`, `owned_by`)
// were missing previously, which caused Codex to treat every model as
// "pending availability" and re-poll /v1/models every 3 minutes — see
// discussion tied to commit history. Crucial fields:
//   - supported_in_api: true      — tells Codex the model is wired up
//   - visibility: "list"          — make the model selectable
//   - shell_type: "shell_command" — enable Codex's built-in shell tool
//   - supported_reasoning_levels  — needed for the reasoning selector
function toOpenAIModelShape({ id, priority }: AvailableModelEntry) {
  return {
    // Legacy OpenAI shape (kept for SDK compatibility)
    id,
    object: "model",
    created: 1704067200,
    owned_by: "tokenparty",
    // Codex 0.144+ extensions. `supported_in_api: true` and
    // `visibility: "list"` together stop the background polling loop.
    slug: id,
    display_name: id,
    description: "",
    default_reasoning_level: "medium",
    supported_reasoning_levels: SUPPORTED_REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
  };
}

openaiRoutes.get("/models", (c) => {
  const token = c.get("authToken");
  const entries = listAvailableModelsDetailed(token, "openai");
  const models = entries.map(toOpenAIModelShape);
  // Codex 0.144+'s ModelsManager deserializes a struct with a required
  // `models` field, not the OpenAI-standard `data`. Return both so
  // OpenAI SDKs and Codex both decode the response — without the
  // `models` key, Codex's manager logs
  // "failed to decode models response: missing field `models`" and
  // re-polls /v1/models every ~3 minutes indefinitely.
  return c.json({
    object: "list",
    data: models,
    models,
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

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
    // Codex 0.144+ ModelInfo (38-field struct, defined in
    // codex-rs/protocol/src/openai_models.rs). The struct is strict:
    // missing or wrong-typed fields trigger
    //   "failed to decode models response: missing field `X`" / "invalid type: ..."
    // and force a re-poll of /v1/models every ~3 minutes. Enum values
    // are serialised in snake_case by serde; see the same file for the
    // full list of variants.
    slug: id,
    display_name: id,
    description: "",
    default_reasoning_level: "medium",
    supported_reasoning_levels: SUPPORTED_REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    // priority must be a finite i32; Infinity JSON-encodes to null.
    priority: Number.isFinite(priority) ? priority : 9999,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: "auto",
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    // model_messages: nested ModelInstructionsVariables (3 optional
    // strings) and ApprovalMessages (2 optional strings) — both must
    // be objects, not arrays, and both default to "absent" via Option.
    model_messages: {
      instructions_template: "",
      instructions_variables: { personality_default: null, personality_friendly: null, personality_pragmatic: null },
      approvals: { on_request: null, on_request_auto_review: null },
    },
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 0 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 128000,
    max_context_window: 128000,
    auto_compact_token_limit: 100000,
    comp_hash: "",
    effective_context_window_percent: 100,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: "",
    tool_mode: "direct",
    multi_agent_version: "v1",
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

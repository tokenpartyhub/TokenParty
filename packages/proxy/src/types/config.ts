import { z } from "zod";

const ModelSchema = z.union([
  z.string(),
  z.object({
    id: z.string(),
    inputPrice: z.number().optional(),
    outputPrice: z.number().optional(),
    cacheReadPrice: z.number().optional(),
    cacheWritePrice: z.number().optional(),
    // Lower number = higher priority. When multiple providers serve the same
    // model, candidates are ordered by priority (then price). On 429/5xx/
    // network error the next candidate is tried automatically.
    priority: z.number().optional(),
  }),
]);

// An entry in a model alias pool. Either a plain model ID string or an
// object with an explicit priority controlling selection order within
// the pool. Pricing is NOT carried here; it comes from the provider's
// own model entry.
export const AliasEntrySchema = z.union([
  z.string(),
  z.object({
    id: z.string(),
    priority: z.number().optional(),
  }),
]);

export const ProviderSchema = z.object({
  id: z.string(),
  type: z.enum(["openai", "anthropic"]),
  name: z.string(),
  apiKey: z.union([z.string(), z.array(z.string())]),
  baseUrl: z.string().url(),
  models: z.array(ModelSchema).default([]),
  enabled: z.boolean().default(true),
  fallback: z.string().optional(),
  group: z.string().optional(),
  currency: z.enum(["USD", "CNY"]).default("USD"),
  // OpenAI-only. When true, an incoming /v1/responses request (Codex 0.144+)
  // is translated to /v1/chat/completions before hitting this upstream, and
  // the response is translated back to Responses format. Lets a provider
  // that only implements Chat Completions serve Responses-API clients.
  // No effect for anthropic providers or for /v1/chat/completions entries.
  responsesToChat: z.boolean().default(false),
});

export const TokenSchema = z.object({
  key: z.string(),
  name: z.string(),
  allowedProviders: z.array(z.string()),
  rateLimit: z.number().nullable().optional(),
  monthlyBudget: z.number().optional(),
  enabled: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().default(3456),
    host: z.string().default("0.0.0.0"),
    logDir: z.string().default("./logs"),
    dataDir: z.string().default("./data"),
    // Hard upper bound on how long we wait for upstream to respond
    // (or to keep streaming). When the upstream hangs longer than
    // this we abort the upstream request and surface a 502 to the
    // client so the dashboard reflects the failure immediately
    // instead of waiting tens of minutes for the socket to give up.
    upstreamTimeoutMs: z.number().default(30_000),
    streamingUpstreamTimeoutMs: z.number().default(300_000),
    // How long per-request detail logs (JSONL on disk) are kept before
    // the daily cleanup job prunes them. The Overview/usage_daily
    // aggregate is preserved beyond this window — only the request
    // detail rows (and request_index entries pointing at them) are
    // removed. If total log dir size still exceeds retentionMaxSizeMB
    // after the time-based pass, oldest days are pruned until under
    // the cap (today is always preserved).
    retentionPeriod: z.enum(["1week", "1month", "2month"]).default("1month"),
    retentionMaxSizeMB: z.number().default(2048),
  }),
  providers: z.array(ProviderSchema),
  tokens: z.array(TokenSchema),
  // Model aliases map a stable name to a pool of real model IDs. When a
  // request arrives with an alias as the model name, the router resolves
  // it to the highest-priority available model in the pool. Lets users
  // pin a stable name (e.g. "minimax-latest") without changing client
  // configs when models upgrade.
  aliases: z.record(z.string(), z.array(AliasEntrySchema)).default({}),
});

// Maps a retention period enum to the number of days of detail logs kept.
// 1week / 1month / 2month are the three options exposed in the Dashboard
// Settings UI; we deliberately keep this an enum rather than a free-form
// number so we can extend the set later without breaking existing
// config.yaml files.
export function retentionPeriodToDays(period: "1week" | "1month" | "2month"): number {
  switch (period) {
    case "1week": return 7;
    case "1month": return 30;
    case "2month": return 60;
  }
}

export type ModelConfig = z.infer<typeof ModelSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type AliasEntry = z.infer<typeof AliasEntrySchema>;

export function getModelId(model: ModelConfig): string {
  return typeof model === "string" ? model : model.id;
}

export function getModelPricing(model: ModelConfig): { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number } | undefined {
  if (typeof model === "string") return undefined;
  if (model.inputPrice === undefined && model.outputPrice === undefined && model.cacheReadPrice === undefined && model.cacheWritePrice === undefined) return undefined;
  return { inputPrice: model.inputPrice, outputPrice: model.outputPrice, cacheReadPrice: model.cacheReadPrice, cacheWritePrice: model.cacheWritePrice };
}

// Returns the model priority. Lower number = higher priority. Unset (or bare
// string model) returns Infinity so it sorts after any explicitly-prioritized
// candidate. Router uses this as the primary sort key.
export function getModelPriority(model: ModelConfig): number {
  if (typeof model === "object" && model.priority !== undefined) return model.priority;
  return Infinity;
}

export function getAliasEntryId(entry: AliasEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

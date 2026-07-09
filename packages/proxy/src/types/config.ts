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
  }),
  providers: z.array(ProviderSchema),
  tokens: z.array(TokenSchema),
});

export type ModelConfig = z.infer<typeof ModelSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type Config = z.infer<typeof ConfigSchema>;

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

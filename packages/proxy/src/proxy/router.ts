import { getConfig } from "../config.js";
import type { Provider, Token, ModelConfig, AliasEntry } from "../types/config.js";
import { getModelId, getModelPricing, getModelPriority, getAliasEntryId, getAliasEntryPriority } from "../types/config.js";

export interface RouteResult {
  provider: Provider;
}

function isProviderAllowed(provider: Provider, allowedProviders: string[]): boolean {
  for (const rule of allowedProviders) {
    if (rule === "*") return true;
    if (rule.startsWith("group:") && provider.group === rule.slice(6)) return true;
    if (rule === provider.id) return true;
  }
  return false;
}

// Total input+output price for a model entry. Unset prices contribute Infinity
// (instead of 0) so that unconfigured models no longer win the price sort by
// default — they sort after priced ones. Priority is the primary sort key, so
// price only breaks ties among candidates with equal (or no) priority.
function modelCost(model: ModelConfig): number {
  const p = getModelPricing(model);
  if (!p) return Infinity;
  const cost = (p.inputPrice ?? Infinity) + (p.outputPrice ?? Infinity);
  return Number.isFinite(cost) ? cost : Infinity;
}

// Check if a model name matches a configured alias. Returns the alias
// pool entries if found, null otherwise. Callers use this to decide
// whether to route via the alias pool or direct model matching.
//
// Distinguishes "alias key missing" (returns null → caller falls through
// to direct-model routing) from "alias exists but pool is empty" (also
// returns null but the caller can treat it differently). The router
// path surfaces a clearer error for the empty case via `aliasPoolIsEmpty`.
export function resolveAlias(model: string): AliasEntry[] | null {
  const config = getConfig();
  if (!(model in (config.aliases ?? {}))) return null;
  const pool = config.aliases?.[model] ?? [];
  if (pool.length === 0) return null;
  return pool;
}

// Companion to resolveAlias: true iff the model name IS a configured
// alias key whose pool is currently empty. Lets the router return an
// actionable error ("alias 'X' has no models") instead of falling
// through to direct-model routing and reporting "No provider for X".
export function aliasPoolIsEmpty(model: string): boolean {
  const config = getConfig();
  const pool = config.aliases?.[model];
  return Array.isArray(pool) && pool.length === 0;
}

// Return the subset of pool entry ids that no enabled provider currently
// serves. Used by API handlers to reject alias saves containing ghosts
// (Fix 1) and by the dashboard to flag stale entries after a provider
// edit (Fix 4). Entries with duplicate ids are deduplicated in the
// returned list so the UI doesn't show the same orphan twice.
export function findOrphanPoolEntries(pool: AliasEntry[]): string[] {
  const config = getConfig();
  const served = new Set<string>();
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    for (const m of provider.models) {
      served.add(getModelId(m));
    }
  }
  const orphans = new Set<string>();
  for (const entry of pool) {
    const id = getAliasEntryId(entry);
    if (!served.has(id)) orphans.add(id);
  }
  return [...orphans];
}

export interface ResolveResult {
  providers: Provider[];
  pricing?: { inputPrice?: number; outputPrice?: number };
  // Maps provider.id to the real model ID it should receive in the
  // upstream body. Only populated when routing via an alias — for
  // direct model requests, body.model already carries the real ID.
  realModelIds?: Map<string, string>;
}

export function resolveProvider(
  model: string,
  token: Token,
  aliasEntries?: AliasEntry[],
): ResolveResult | { error: string } {
  const config = getConfig();

  // --- Alias pool routing ---
  if (aliasEntries) {
    return resolveAliasProvider(aliasEntries, token, model);
  }

  // --- Direct model routing (unchanged) ---
  // If the model name is actually a configured alias whose pool is empty,
  // surface that specifically — otherwise users see the misleading
  // "No provider available for model: <aliasName>".
  if (aliasPoolIsEmpty(model)) {
    return { error: `Alias '${model}' has no models in its pool` };
  }

  const candidateProviders = config.providers.filter(
    (p) => p.enabled && p.models.some((m) => getModelId(m) === model)
  );

  if (candidateProviders.length === 0) {
    return { error: `No provider available for model: ${model}` };
  }

  const allowed = candidateProviders.filter((p) => isProviderAllowed(p, token.allowedProviders));
  if (allowed.length === 0) {
    return { error: `Token not authorized for any provider serving model: ${model}` };
  }

  // Sort by [priority asc, price asc]. Explicitly-prioritized providers come
  // first (by priority), then unprioritized ones by price. This ordered list
  // doubles as the fallback chain: on 429/5xx/network error the forwarder
  // tries the next candidate.
  allowed.sort((a, b) => {
    const ma = a.models.find((m) => getModelId(m) === model)!;
    const mb = b.models.find((m) => getModelId(m) === model)!;
    const prioDiff = getModelPriority(ma) - getModelPriority(mb);
    if (prioDiff !== 0) return prioDiff;
    return modelCost(ma) - modelCost(mb);
  });

  const match = allowed[0];
  const modelConfig = match.models.find((m) => getModelId(m) === model);
  return { providers: allowed, pricing: modelConfig ? getModelPricing(modelConfig) : undefined };
}

// Resolve providers for an alias pool. Each entry in the pool maps to a
// real model ID; we find all providers serving each real model, collect
// them into a flat candidate list, and sort by:
//   1. Alias pool priority (position in the pool) — primary key
//   2. Provider model priority — secondary key
//   3. Price — tiebreaker
// The result includes a realModelIds map so the forwarder knows which
// real model ID to put in body.model per provider attempt.
function resolveAliasProvider(
  aliasEntries: AliasEntry[],
  token: Token,
  aliasName: string,
): ResolveResult | { error: string } {
  const config = getConfig();
  const realModelIds = new Map<string, string>();

  interface Candidate {
    provider: Provider;
    realModelId: string;
    poolPosition: number;
    providerPriority: number;
    cost: number;
  }

  const candidates: Candidate[] = [];

  for (let pos = 0; pos < aliasEntries.length; pos++) {
    const entry = aliasEntries[pos];
    const realId = getAliasEntryId(entry);

    for (const provider of config.providers) {
      if (!provider.enabled) continue;
      if (!isProviderAllowed(provider, token.allowedProviders)) continue;
      const providerModel = provider.models.find((m) => getModelId(m) === realId);
      if (!providerModel) continue;

      candidates.push({
        provider,
        realModelId: realId,
        poolPosition: pos,
        providerPriority: getModelPriority(providerModel),
        cost: modelCost(providerModel),
      });
      realModelIds.set(provider.id, realId);
    }
  }

  if (candidates.length === 0) {
    return { error: `No provider available for alias: ${aliasName}` };
  }

  // Array position in the pool IS the priority: earlier = preferred.
  // Provider priority and cost break ties within the same pool position.
  candidates.sort((a, b) => {
    const posDiff = a.poolPosition - b.poolPosition;
    if (posDiff !== 0) return posDiff;
    const provDiff = a.providerPriority - b.providerPriority;
    if (provDiff !== 0) return provDiff;
    return a.cost - b.cost;
  });

  const providers = candidates.map((c) => c.provider);
  // Deduplicate providers (a provider could serve multiple models in the pool)
  const seen = new Set<string>();
  const deduped: Provider[] = [];
  const dedupedRealModelIds = new Map<string, string>();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    deduped.push(p);
    dedupedRealModelIds.set(p.id, candidates[i].realModelId);
  }

  // Pricing from the first candidate's real model
  const first = candidates[0];
  const firstModelConfig = first.provider.models.find((m) => getModelId(m) === first.realModelId);
  return {
    providers: deduped,
    pricing: firstModelConfig ? getModelPricing(firstModelConfig) : undefined,
    realModelIds: dedupedRealModelIds,
  };
}

export function listAvailableModels(token: Token, protocol?: "anthropic" | "openai"): string[] {
  const config = getConfig();
  const models = new Set<string>();

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    if (protocol && provider.type !== protocol) continue;
    if (!isProviderAllowed(provider, token.allowedProviders)) continue;
    for (const model of provider.models) {
      models.add(getModelId(model));
    }
  }

  // Include alias names — they are valid model identifiers that clients
  // can request, and they need to appear in /v1/models for tools like Codex.
  if (config.aliases) {
    for (const aliasName of Object.keys(config.aliases)) {
      models.add(aliasName);
    }
  }

  return [...models];
}

// Like listAvailableModels but returns one entry per (provider, model) pair
// rather than a deduplicated set of ids. Used by the OpenAI /v1/models
// handler to emit Codex-friendly metadata (priority) alongside the basic
// id. Deduplication is the caller's responsibility.
export interface AvailableModelEntry {
  id: string;
  priority: number;
}

export function listAvailableModelsDetailed(token: Token, protocol: "anthropic" | "openai"): AvailableModelEntry[] {
  const config = getConfig();
  const out: AvailableModelEntry[] = [];
  const seenIds = new Set<string>();

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    if (provider.type !== protocol) continue;
    if (!isProviderAllowed(provider, token.allowedProviders)) continue;
    for (const model of provider.models) {
      out.push({ id: getModelId(model), priority: getModelPriority(model) });
      seenIds.add(getModelId(model));
    }
  }

  // Append aliases — pool position IS the priority. Only include aliases
  // whose pool has at least one model served by a matching provider type
  // — an alias with only anthropic models shouldn't show up on the openai
  // /v1/models endpoint.
  if (config.aliases) {
    for (const [aliasName, pool] of Object.entries(config.aliases)) {
      if (seenIds.has(aliasName)) continue;
      let bestPosition = Infinity;
      let hasMatchingProvider = false;
      for (let pos = 0; pos < pool.length; pos++) {
        const realId = getAliasEntryId(pool[pos]);
        for (const provider of config.providers) {
          if (!provider.enabled) continue;
          if (provider.type !== protocol) continue;
          if (!isProviderAllowed(provider, token.allowedProviders)) continue;
          if (provider.models.some((m) => getModelId(m) === realId)) {
            hasMatchingProvider = true;
            if (pos < bestPosition) bestPosition = pos;
          }
        }
      }
      if (hasMatchingProvider) {
        out.push({ id: aliasName, priority: bestPosition });
      }
    }
  }

  return out;
}

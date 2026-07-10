import { getConfig } from "../config.js";
import type { Provider, Token, ModelConfig } from "../types/config.js";
import { getModelId, getModelPricing, getModelPriority } from "../types/config.js";

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

export function resolveProvider(model: string, token: Token): { providers: Provider[]; pricing?: { inputPrice?: number; outputPrice?: number } } | { error: string } {
  const config = getConfig();

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

  return [...models];
}

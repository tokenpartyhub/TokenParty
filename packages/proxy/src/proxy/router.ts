import { getConfig } from "../config.js";
import type { Provider, Token } from "../types/config.js";
import { getModelId, getModelPricing } from "../types/config.js";

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

export function resolveProvider(model: string, token: Token): RouteResult & { pricing?: { inputPrice?: number; outputPrice?: number } } | { error: string } {
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

  allowed.sort((a, b) => {
    const pa = getModelPricing(a.models.find((m) => getModelId(m) === model)!);
    const pb = getModelPricing(b.models.find((m) => getModelId(m) === model)!);
    const costA = pa ? (pa.inputPrice ?? 0) + (pa.outputPrice ?? 0) : 0;
    const costB = pb ? (pb.inputPrice ?? 0) + (pb.outputPrice ?? 0) : 0;
    return costA - costB;
  });

  const match = allowed[0];
  const modelConfig = match.models.find((m) => getModelId(m) === model);
  return { provider: match, pricing: modelConfig ? getModelPricing(modelConfig) : undefined };
}

export function listAvailableModels(token: Token): string[] {
  const config = getConfig();
  const models = new Set<string>();

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    if (!isProviderAllowed(provider, token.allowedProviders)) continue;
    for (const model of provider.models) {
      models.add(getModelId(model));
    }
  }

  return [...models];
}

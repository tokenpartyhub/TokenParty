import { getDb } from "../store/db.js";

export interface RequestRecord {
  id: string;
  tokenId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs: number;
  status: number;
  logFile: string;
  error?: string;
  apiKeyIndex?: number;
  pricing?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number };
  currency?: string;
  agent?: string;
  customTags?: string;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  pricing?: { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number }
): number {
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * (pricing.inputPrice ?? 0);
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheReadPrice ?? pricing.inputPrice ?? 0);
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePrice ?? pricing.inputPrice ?? 0);
  const outputCost = (outputTokens / 1_000_000) * (pricing.outputPrice ?? 0);
  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

export function recordRequest(record: RequestRecord) {
  const db = getDb();
  const now = Date.now();
  const date = new Date(now).toISOString().split("T")[0];
  const cacheReadTokens = record.cacheReadTokens ?? 0;
  const cacheWriteTokens = record.cacheWriteTokens ?? 0;
  const CNY_TO_USD = 1 / 7.2;
  let cost = calculateCost(record.inputTokens, record.outputTokens, cacheReadTokens, cacheWriteTokens, record.pricing);
  if (record.currency === "CNY") cost *= CNY_TO_USD;

  const agent = record.agent ?? "";
  const customTags = record.customTags ?? "";

  db.prepare(`
    INSERT INTO request_index (id, timestamp, token_id, provider_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, status, log_file, error, api_key_index, cost, agent, custom_tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, now, record.tokenId, record.providerId, record.model,
    record.inputTokens, record.outputTokens, cacheReadTokens, cacheWriteTokens, record.latencyMs,
    record.status, record.logFile, record.error ?? null, record.apiKeyIndex ?? 0, cost, agent, customTags
  );

  db.prepare(`
    INSERT INTO usage_daily (date, token_id, provider_id, model, agent, request_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(date, token_id, provider_id, model, agent)
    DO UPDATE SET
      request_count = request_count + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      cost = cost + excluded.cost
  `).run(date, record.tokenId, record.providerId, record.model, agent, record.inputTokens, record.outputTokens, cacheReadTokens, cacheWriteTokens, cost);
}

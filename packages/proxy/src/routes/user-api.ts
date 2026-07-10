import { Hono } from "hono";
import { getConfig } from "../config.js";
import { getDb } from "../store/db.js";
import { readLog } from "../store/log-writer.js";
import { getModelId } from "../types/config.js";
import type { UserApiEnv } from "../types/env.js";

export const userApiRoutes = new Hono<UserApiEnv>();

userApiRoutes.use("/*", async (c, next) => {
  const auth = c.req.header("authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!key) return c.json({ error: "Unauthorized" }, 401);

  const config = getConfig();
  const token = config.tokens.find((t) => t.key === key && t.enabled);
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  c.set("userToken", token);
  await next();
});

userApiRoutes.get("/models", (c) => {
  // Per-model protocols: a model is routable via each provider that
  // exposes it, so the same model id can appear under multiple
  // protocols (e.g. served by both an anthropic and an openai
  // provider). The Agent Setup page consumes this list directly to
  // render protocol badges and per-agent model pickers - non-admin
  // users hit this endpoint because GET /api/models is admin-only.
  const config = getConfig();
  const byId = new Map<string, Set<string>>();
  for (const p of config.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      const id = getModelId(m);
      const set = byId.get(id) ?? new Set<string>();
      set.add(p.type);
      byId.set(id, set);
    }
  }
  return c.json(
    [...byId.entries()]
      .map(([id, protocols]) => ({ id, protocols: [...protocols] }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );
});

userApiRoutes.get("/profile", (c) => {
  const token = c.get("userToken");
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.slice(0, 7) + "-01";

  const monthly = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(request_count), 0) as requests,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
    FROM usage_daily WHERE token_id = ? AND date >= ?
  `).get(token.key, monthStart) as any;

  const daily = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as cost,
      COALESCE(SUM(request_count), 0) as requests
    FROM usage_daily WHERE token_id = ? AND date = ?
  `).get(token.key, today) as any;

  return c.json({
    name: token.name,
    monthlyBudget: token.monthlyBudget ?? null,
    monthlySpent: monthly.cost,
    monthlyRequests: monthly.requests,
    monthlyInputTokens: monthly.input_tokens,
    monthlyOutputTokens: monthly.output_tokens,
    monthlyCacheReadTokens: monthly.cache_read_tokens,
    dailySpent: daily.cost,
    dailyRequests: daily.requests,
  });
});

userApiRoutes.get("/stats", (c) => {
  const token = c.get("userToken");
  const db = getDb();
  const days = Number(c.req.query("days") ?? 7);
  const rows = db.prepare(
    `SELECT * FROM usage_daily WHERE token_id = ? AND date >= date('now', '-' || ? || ' days') ORDER BY date DESC`
  ).all(token.key, days);
  return c.json(rows);
});

userApiRoutes.get("/requests", (c) => {
  const token = c.get("userToken");
  const db = getDb();
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);
  const providerId = c.req.query("provider_id");
  const model = c.req.query("model");
  const status = c.req.query("status");
  const tags = c.req.query("tags");
  const agent = c.req.query("agent");
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");

  let where = `WHERE token_id = ?`;
  const params: any[] = [token.key];

  if (providerId) { where += ` AND provider_id = ?`; params.push(providerId); }
  if (model) { where += ` AND model = ?`; params.push(model); }
  if (status === "ok") { where += ` AND status = 200`; }
  else if (status === "error") { where += ` AND status != 200`; }
  if (agent) { where += ` AND agent = ?`; params.push(agent); }
  if (dateFrom) {
    const ts = new Date(dateFrom + "T00:00:00").getTime();
    if (!Number.isNaN(ts)) { where += ` AND timestamp >= ?`; params.push(ts); }
  }
  if (dateTo) {
    const ts = new Date(dateTo + "T23:59:59.999").getTime();
    if (!Number.isNaN(ts)) { where += ` AND timestamp <= ?`; params.push(ts); }
  }
  if (tags) {
    for (const tag of tags.split(",").map((t) => t.trim()).filter(Boolean)) {
      where += ` AND custom_tags LIKE ?`;
      params.push(`%${tag}%`);
    }
  }

  const rows = db.prepare(`SELECT * FROM request_index ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as count FROM request_index ${where}`).get(...params) as any;
  return c.json({ data: rows, total: total.count });
});

userApiRoutes.get("/requests/:id", (c) => {
  const token = c.get("userToken");
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare(`SELECT * FROM request_index WHERE id = ? AND token_id = ?`).get(id, token.key) as any;
  if (!row) return c.json({ error: "Not found" }, 404);
  const logs = readLog(row.log_file);
  return c.json({ ...row, logs });
});

import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import { getDb } from "../store/db.js";
import type { AppEnv } from "../types/env.js";

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const config = getConfig();
  const authHeader = c.req.header("Authorization") ?? "";
  const key = authHeader.replace(/^Bearer\s+/i, "");

  if (!key) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = config.tokens.find((t) => t.key === key && t.enabled);
  if (!token) {
    return c.json({ error: "Invalid or disabled token" }, 401);
  }

  if (token.monthlyBudget) {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const monthStart = today.slice(0, 7) + "-01";
    const row = db.prepare(
      `SELECT COALESCE(SUM(cost), 0) as total_cost FROM usage_daily WHERE token_id = ? AND date >= ?`
    ).get(token.key, monthStart) as { total_cost: number };
    if (row.total_cost >= token.monthlyBudget) {
      return c.json({ error: "Monthly budget exceeded" }, 429);
    }
  }

  c.set("authToken", token);
  await next();
}

import { Hono } from "hono";
import { getConfig, updateConfig } from "../config.js";
import { getDb, validateAdminToken, getSetting, setSetting } from "../store/db.js";
import { readLog, getLogStats, cleanupLogs, clearAllLogs } from "../store/log-writer.js";
import { nanoid } from "nanoid";
import { getModelId } from "../types/config.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));

export const apiRoutes = new Hono();

// --- Auth ---

apiRoutes.post("/auth/verify", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  return c.json({ valid: validateAdminToken(token) });
});

apiRoutes.use("/*", async (c, next) => {
  if (c.req.path === "/api/auth/verify") return next();
  const auth = c.req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token || !validateAdminToken(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// --- Version ---

apiRoutes.get("/version", (c) => c.json({ version: pkg.version }));

apiRoutes.get("/version/check", async (c) => {
  try {
    const res = await fetch("https://registry.npmjs.org/@zhouzhengchang/token-party/latest");
    if (!res.ok) return c.json({ current: pkg.version, latest: null, hasUpdate: false });
    const data = await res.json() as { version: string };
    const latest = data.version;
    const hasUpdate = latest !== pkg.version;
    return c.json({ current: pkg.version, latest, hasUpdate });
  } catch {
    return c.json({ current: pkg.version, latest: null, hasUpdate: false });
  }
});

// --- Models ---

apiRoutes.get("/models", (c) => {
  const config = getConfig();
  const models: { id: string; providers: string[] }[] = [];
  for (const p of config.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      const id = getModelId(m);
      const existing = models.find((x) => x.id === id);
      if (existing) {
        existing.providers.push(p.id);
      } else {
        models.push({ id, providers: [p.id] });
      }
    }
  }
  return c.json(models);
});

// --- Providers ---

apiRoutes.get("/providers", (c) => {
  const config = getConfig();
  const providers = config.providers.map((p) => ({
    ...p,
    apiKey: Array.isArray(p.apiKey) ? p.apiKey.map(maskKey) : maskKey(p.apiKey),
  }));
  return c.json(providers);
});

apiRoutes.post("/providers", async (c) => {
  const body = await c.req.json();
  const newProvider = { id: body.id ?? nanoid(8), ...body, enabled: body.enabled ?? true };
  updateConfig((raw) => {
    (raw.providers as any[]).push(newProvider);
  });
  return c.json(newProvider, 201);
});

apiRoutes.put("/providers/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (body.apiKey) {
    if (Array.isArray(body.apiKey)) {
      if (body.apiKey.every((k: string) => k.includes("****"))) delete body.apiKey;
    } else if (body.apiKey.includes("****")) {
      delete body.apiKey;
    }
  }
  updateConfig((raw) => {
    const providers = raw.providers as any[];
    const idx = providers.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Provider not found");
    providers[idx] = { ...providers[idx], ...body };
  });
  return c.json({ ok: true });
});

apiRoutes.delete("/providers/:id", async (c) => {
  const id = c.req.param("id");
  updateConfig((raw) => {
    raw.providers = (raw.providers as any[]).filter((p) => p.id !== id);
  });
  return c.json({ ok: true });
});

// --- Tokens (Keys) ---

apiRoutes.get("/keys", (c) => {
  const config = getConfig();
  return c.json(config.tokens);
});

apiRoutes.post("/keys", async (c) => {
  const body = await c.req.json();
  const newToken = {
    key: body.key ?? `tp-${nanoid(16)}`,
    name: body.name,
    allowedProviders: body.allowedProviders ?? [],
    rateLimit: body.rateLimit ?? null,
    enabled: body.enabled ?? true,
  };
  updateConfig((raw) => {
    (raw.tokens as any[]).push(newToken);
  });
  return c.json(newToken, 201);
});

apiRoutes.put("/keys/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  updateConfig((raw) => {
    const tokens = raw.tokens as any[];
    const idx = tokens.findIndex((t) => t.key === key);
    if (idx === -1) throw new Error("Token not found");
    tokens[idx] = { ...tokens[idx], ...body };
  });
  return c.json({ ok: true });
});

apiRoutes.delete("/keys/:key", async (c) => {
  const key = c.req.param("key");
  updateConfig((raw) => {
    raw.tokens = (raw.tokens as any[]).filter((t) => t.key !== key);
  });
  return c.json({ ok: true });
});

// --- Stats ---

apiRoutes.get("/stats", (c) => {
  const db = getDb();
  const days = Number(c.req.query("days") ?? 7);
  const tokenId = c.req.query("token_id");

  let query = `SELECT * FROM usage_daily WHERE date >= date('now', '-${days} days')`;
  const params: any[] = [];
  if (tokenId) {
    query += ` AND token_id = ?`;
    params.push(tokenId);
  }
  query += ` ORDER BY date DESC`;

  const rows = db.prepare(query).all(...params);
  return c.json(rows);
});

// --- Requests ---

apiRoutes.get("/requests", (c) => {
  const db = getDb();
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);
  const tokenId = c.req.query("token_id");
  const providerId = c.req.query("provider_id");
  const model = c.req.query("model");
  const status = c.req.query("status");
  const tags = c.req.query("tags");

  let where = `WHERE 1=1`;
  const params: any[] = [];

  if (tokenId) { where += ` AND token_id = ?`; params.push(tokenId); }
  if (providerId) { where += ` AND provider_id = ?`; params.push(providerId); }
  if (model) { where += ` AND model = ?`; params.push(model); }
  if (status === "ok") { where += ` AND status = 200`; }
  else if (status === "error") { where += ` AND status != 200`; }
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

apiRoutes.get("/requests/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare(`SELECT * FROM request_index WHERE id = ?`).get(id) as any;
  if (!row) return c.json({ error: "Not found" }, 404);

  const logs = readLog(row.log_file);
  return c.json({ ...row, logs });
});

// --- Settings ---

apiRoutes.get("/settings/log-storage", (c) => {
  const stats = getLogStats();
  return c.json(stats);
});

apiRoutes.put("/settings/log-storage", async (c) => {
  const { maxSizeMB } = await c.req.json<{ maxSizeMB: number }>();
  if (!maxSizeMB || maxSizeMB < 50) return c.json({ error: "Minimum 50MB" }, 400);
  setSetting("max_log_size_mb", String(maxSizeMB));
  const result = cleanupLogs();
  const stats = getLogStats();
  return c.json({ ...stats, cleaned: result });
});

apiRoutes.post("/settings/log-cleanup", (c) => {
  const result = cleanupLogs();
  const stats = getLogStats();
  return c.json({ ...stats, cleaned: result });
});

apiRoutes.delete("/settings/log-storage", (c) => {
  const result = clearAllLogs();
  const stats = getLogStats();
  return c.json({ ...stats, cleared: result });
});

function maskKey(key: string): string {
  if (key.startsWith("${")) return key;
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

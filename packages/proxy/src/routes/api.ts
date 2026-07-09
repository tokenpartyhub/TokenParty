import { Hono } from "hono";
import { getConfig, updateConfig } from "../config.js";
import { getDb, validateAdminToken, getSetting, setSetting } from "../store/db.js";
import { readLog, getLogStats, runRetentionCleanup, clearAllLogs } from "../store/log-writer.js";
import { nanoid } from "nanoid";
import { getModelId, ProviderSchema } from "../types/config.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));

export const apiRoutes = new Hono();

// Validate a provider object against the schema. Returns a human-readable
// error string, or null when valid. Used to reject invalid configs (e.g. a
// baseUrl missing its protocol) at save time rather than crashing on startup.
function validateProvider(provider: any): string | null {
  const result = ProviderSchema.safeParse(provider);
  if (result.success) return null;
  return result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

// --- Auth ---

apiRoutes.post("/auth/verify", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (validateAdminToken(token)) {
    return c.json({ valid: true, role: "admin" });
  }
  const config = getConfig();
  const userToken = config.tokens.find((t) => t.key === token && t.enabled);
  if (userToken) {
    return c.json({ valid: true, role: "user", name: userToken.name });
  }
  return c.json({ valid: false });
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
    const res = await fetch("https://registry.npmjs.org/@tokenparty/tokenparty/latest");
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
  const error = validateProvider(newProvider);
  if (error) return c.json({ error: "Invalid provider config", detail: error }, 400);
  updateConfig((raw) => {
    (raw.providers as any[]).push(newProvider);
  });
  return c.json(newProvider, 201);
});

apiRoutes.put("/providers/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (body.apiKey) {
    const config = getConfig();
    const existing = config.providers.find((p) => p.id === id);
    const existingKeys = existing ? (Array.isArray(existing.apiKey) ? existing.apiKey : [existing.apiKey]) : [];

    if (Array.isArray(body.apiKey)) {
      const resolved = body.apiKey.map((k: string, i: number) => {
        if (k.includes("****") && i < existingKeys.length) return existingKeys[i];
        if (k.includes("****")) return null;
        return k;
      }).filter(Boolean);
      if (resolved.length === 0) {
        delete body.apiKey;
      } else {
        body.apiKey = resolved.length === 1 ? resolved[0] : resolved;
      }
    } else if (body.apiKey.includes("****")) {
      delete body.apiKey;
    }
  }
  // Validate the merged provider before persisting. Compute the merged shape
  // from the current config (not raw yaml) since apiKey masking is resolved
  // above into body.
  const config = getConfig();
  const existing = config.providers.find((p) => p.id === id);
  if (!existing) return c.json({ error: "Provider not found" }, 404);
  const merged = { ...existing, ...body };
  const error = validateProvider(merged);
  if (error) return c.json({ error: "Invalid provider config", detail: error }, 400);

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

// Detect available models from an upstream provider by calling its models
// endpoint. Uses the provider's real (unmasked) apiKey. Returns the list of
// model ids; does not mutate config — the dashboard decides how to merge.
apiRoutes.post("/providers/:id/detect-models", async (c) => {
  const id = c.req.param("id");
  const config = getConfig();
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) return c.json({ error: "Provider not found" }, 404);

  const keys = Array.isArray(provider.apiKey) ? provider.apiKey : [provider.apiKey];
  const apiKey = keys[0];
  const base = provider.baseUrl.replace(/\/$/, "");

  // Pick the models endpoint path per provider type. Anthropic uses
  // /v1/models (and some gateways /models); OpenAI uses /v1/models.
  const path = provider.type === "anthropic" ? "/v1/models" : "/v1/models";
  const url = `${base}${path}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.type === "openai") {
    headers["authorization"] = `Bearer ${apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    if (!res.ok) {
      return c.json({ error: `Upstream returned ${res.status}`, detail: text.slice(0, 500) }, 502);
    }
    let data: any;
    try { data = JSON.parse(text); } catch {
      return c.json({ error: "Upstream returned non-JSON response", detail: text.slice(0, 500) }, 502);
    }

    // Normalize both OpenAI ({object, data:[{id}]}) and Anthropic
    // ({data:[{id}]}) shapes into a flat id list.
    const list: any[] = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
    const modelIds = list
      .map((m: any) => (typeof m === "string" ? m : m?.id))
      .filter((id: any): id is string => typeof id === "string" && id.length > 0);

    return c.json({ models: modelIds });
  } catch (e: any) {
    return c.json({ error: "Failed to reach upstream", detail: e.message }, 502);
  }
});

// --- Tokens (Keys) ---

apiRoutes.get("/keys", (c) => {
  const config = getConfig();
  return c.json(config.tokens);
});

apiRoutes.get("/keys/usage-summary", (c) => {
  const db = getDb();
  const monthStart = new Date().toISOString().split("T")[0].slice(0, 7) + "-01";
  const rows = db.prepare(`
    SELECT token_id,
      COALESCE(SUM(cost), 0) as monthly_cost,
      COALESCE(SUM(request_count), 0) as monthly_requests,
      COALESCE(SUM(input_tokens), 0) as monthly_input_tokens,
      COALESCE(SUM(output_tokens), 0) as monthly_output_tokens
    FROM usage_daily WHERE date >= ?
    GROUP BY token_id
  `).all(monthStart);
  return c.json(rows);
});

apiRoutes.post("/keys", async (c) => {
  const body = await c.req.json();
  const newToken: Record<string, any> = {
    key: body.key ?? `tp-${nanoid(16)}`,
    name: body.name,
    allowedProviders: body.allowedProviders ?? [],
    rateLimit: body.rateLimit ?? null,
    enabled: body.enabled ?? true,
  };
  if (body.monthlyBudget !== undefined) newToken.monthlyBudget = body.monthlyBudget;
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
  const agent = c.req.query("agent");
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");

  let where = `WHERE 1=1`;
  const params: any[] = [];

  if (tokenId) { where += ` AND token_id = ?`; params.push(tokenId); }
  if (providerId) { where += ` AND provider_id = ?`; params.push(providerId); }
  if (model) { where += ` AND model = ?`; params.push(model); }
  if (status === "ok") { where += ` AND status = 200`; }
  else if (status === "error") { where += ` AND status != 200`; }
  if (agent) { where += ` AND agent = ?`; params.push(agent); }
  // SQLite type affinity compares strings to integers by casting the string
  // to numeric, which truncates "2026-06-28T00:00:00" to 2026 and never
  // matches the epoch-ms timestamp column. Convert the YYYY-MM-DD input to
  // local-time epoch ms before binding.
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
  // Accepts either (a) legacy { maxSizeMB } — translated into
  // retentionMaxSizeMB on a fresh 1month period — or (b) the new shape
  // { retentionPeriod, retentionMaxSizeMB } that the Settings page sends.
  const body = await c.req.json<{ maxSizeMB?: number; retentionPeriod?: "1week" | "1month" | "2month"; retentionMaxSizeMB?: number }>();
  const update: Record<string, unknown> = {};
  if (body.retentionPeriod) update.retentionPeriod = body.retentionPeriod;
  if (typeof body.retentionMaxSizeMB === "number") {
    if (body.retentionMaxSizeMB < 50) return c.json({ error: "Minimum 50MB" }, 400);
    update.retentionMaxSizeMB = body.retentionMaxSizeMB;
  } else if (typeof body.maxSizeMB === "number") {
    if (body.maxSizeMB < 50) return c.json({ error: "Minimum 50MB" }, 400);
    update.retentionMaxSizeMB = body.maxSizeMB;
  }
  if (Object.keys(update).length === 0) return c.json({ error: "No fields to update" }, 400);
  updateConfig((raw) => {
    const server = raw.server as Record<string, unknown>;
    if (update.retentionPeriod) server.retentionPeriod = update.retentionPeriod;
    if (update.retentionMaxSizeMB) server.retentionMaxSizeMB = update.retentionMaxSizeMB;
  });
  // Drop the legacy SQLite setting; retention is now config-driven.
  getDb().prepare("DELETE FROM settings WHERE key = ?").run("max_log_size_mb");
  const result = runRetentionCleanup();
  const stats = getLogStats();
  return c.json({ ...stats, cleaned: result });
});

apiRoutes.post("/settings/log-cleanup", (c) => {
  const result = runRetentionCleanup();
  const stats = getLogStats();
  return c.json({ ...stats, cleaned: result });
});

apiRoutes.delete("/settings/log-storage", (c) => {
  const result = clearAllLogs();
  const stats = getLogStats();
  return c.json({ ...stats, cleared: result });
});

// --- Restart ---

apiRoutes.post("/restart", async (c) => {
  console.log("[tokenparty] Restart requested via API, restarting...");
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");

  setTimeout(() => {
    // Spawn detached so the child survives our exit. We don't inherit stdio:
    // when we process.exit() the parent's fds close and any stdio: "inherit"
    // child output would be silently lost. Detach stdio instead so the child
    // can keep its own stdio (or be redirected by whatever started us).
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TOKENPARTY_DAEMON: "1" },
    });
    child.unref();

    // Refresh the PID file so subsequent `tokenparty stop/status` target
    // the new process instead of the now-dead parent.
    try {
      const pidFile = path.join(os.homedir(), ".tokenparty", "tokenparty.pid");
      fs.writeFileSync(pidFile, String(child.pid));
    } catch (e) {
      console.error("[tokenparty] Failed to write PID file:", e);
    }

    process.exit(0);
  }, 500);
  return c.json({ status: "restarting" });
});

function maskKey(key: string): string {
  if (key.startsWith("${")) return key;
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

import { Hono } from "hono";
import { getConfig, updateConfig } from "../config.js";
import { getDb, validateAdminToken, getSetting, setSetting } from "../store/db.js";
import { readLog, getLogStats, runRetentionCleanup, clearAllLogs } from "../store/log-writer.js";
import { nanoid } from "nanoid";
import { getModelId, ProviderSchema, getAliasEntryId, type AliasEntry } from "../types/config.js";
import { findOrphanPoolEntries } from "../proxy/router.js";
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

// Public token probe endpoint. Returns ONLY { valid: boolean } — no role
// or name — so an unauthenticated caller can't enumerate which tokens
// exist or learn the human-readable label of any token. The dashboard
// uses /auth/verify just to gate login; once logged in, it relies on the
// admin auth middleware for any actual data fetch.
apiRoutes.post("/auth/verify", async (c) => {
  try {
    const body = await c.req.json<{ token?: unknown }>();
    if (typeof body?.token !== "string" || body.token.length === 0 || body.token.length > 256) {
      return c.json({ valid: false });
    }
    if (validateAdminToken(body.token)) return c.json({ valid: true });
    const config = getConfig();
    const userToken = config.tokens.find((t) => t.key === body.token && t.enabled);
    return c.json({ valid: !!userToken });
  } catch {
    // Malformed body, oversized payload, etc. — never reveal anything.
    return c.json({ valid: false });
  }
});

apiRoutes.use("/*", async (c, next) => {
  // /auth/verify is a public probe (no role disclosure); /me does its own
  // per-request auth so it can serve either admin or user tokens without
  // requiring the admin middleware.
  if (c.req.path === "/api/auth/verify" || c.req.path === "/api/me") return next();
  const auth = c.req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token || !validateAdminToken(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// Returns identity info for an already-authenticated bearer token. Used
// by the dashboard's Login flow after /auth/verify confirms the token is
// valid — separates "is this token valid?" (cheap public probe) from
// "what role and label does this token have?" (authenticated lookup).
apiRoutes.get("/me", (c) => {
  const auth = c.req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  if (validateAdminToken(token)) {
    return c.json({ role: "admin", name: "Admin" });
  }
  const config = getConfig();
  const userToken = config.tokens.find((t) => t.key === token && t.enabled);
  if (userToken) return c.json({ role: "user", name: userToken.name });
  return c.json({ error: "Unauthorized" }, 401);
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
  const models: { id: string; providers: string[]; isAlias?: boolean; pool?: any[] }[] = [];
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
  // Append aliases as virtual model entries so the dashboard can show them
  // alongside real models.
  if (config.aliases) {
    for (const [aliasName, pool] of Object.entries(config.aliases)) {
      models.push({ id: aliasName, providers: [], isAlias: true, pool });
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

// Given the new provider shape (post-edit) and the id being edited, scan
// the current aliases map and report which alias pool entries become
// orphaned by this change. Each report entry carries the alias name and
// the index in its pool so the dashboard can highlight the exact rows.
function detectAliasOrphans(
  config: { aliases?: Record<string, AliasEntry[]> },
  newProviderModelIds: Set<string>,
  oldProviderModelIds: Set<string>,
): { alias: string; index: number; modelId: string }[] {
  const removed = new Set<string>();
  for (const id of oldProviderModelIds) {
    if (!newProviderModelIds.has(id)) removed.add(id);
  }
  if (removed.size === 0) return [];
  const orphans: { alias: string; index: number; modelId: string }[] = [];
  for (const [aliasName, pool] of Object.entries(config.aliases ?? {})) {
    for (let i = 0; i < pool.length; i++) {
      const id = getAliasEntryId(pool[i]);
      if (removed.has(id)) {
        orphans.push({ alias: aliasName, index: i, modelId: id });
      }
    }
  }
  return orphans;
}

// Strip pool entries whose real model id no longer exists in any enabled
// provider (or whose id matches one of `removedIds` from a deleted provider).
// Returns the count of aliases whose pool became empty as a side effect.
function pruneAliasPools(
  raw: any,
  removedIds: Set<string>,
): { emptiedAliases: string[] } {
  const aliases = (raw.aliases ?? {}) as Record<string, AliasEntry[]>;
  const emptiedAliases: string[] = [];
  for (const [name, pool] of Object.entries(aliases)) {
    const next: AliasEntry[] = [];
    for (const entry of pool) {
      if (!removedIds.has(getAliasEntryId(entry))) next.push(entry);
    }
    if (next.length === 0) {
      // Leave the alias key in place with an empty pool — the router now
      // surfaces "Alias 'X' has no models" instead of confusingly falling
      // through to direct-model routing. Dashboard can decide to delete it.
      aliases[name] = [];
      emptiedAliases.push(name);
    } else {
      aliases[name] = next;
    }
  }
  raw.aliases = aliases;
  return { emptiedAliases };
}

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

  // Snapshot the model ids before/after the edit so we can flag alias
  // pool entries that become orphaned by the model change. We don't auto-
  // prune here — the dashboard wants to see the warning and confirm.
  const oldIds = new Set<string>((existing.models ?? []).map((m: any) => getModelId(m)));
  const newIds = new Set<string>(((merged as any).models ?? []).map((m: any) => getModelId(m)));
  const orphaned = detectAliasOrphans(config, newIds, oldIds);

  updateConfig((raw) => {
    const providers = raw.providers as any[];
    const idx = providers.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Provider not found");
    providers[idx] = { ...providers[idx], ...body };
  });
  return c.json({ ok: true, orphaned });
});

apiRoutes.delete("/providers/:id", async (c) => {
  const id = c.req.param("id");
  const cascade = c.req.query("cascade") === "aliases";
  const config = getConfig();
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) return c.json({ error: "Provider not found" }, 404);

  // Collect ids that disappear with this provider — its own models, plus
  // any other provider that has `fallback: <this-id>` set (defensive: the
  // fallback chain in forwarder would otherwise dangle).
  const removedIds = new Set((provider.models ?? []).map((m) => getModelId(m)));
  for (const other of config.providers) {
    if (other.fallback === id) {
      for (const m of other.models ?? []) removedIds.add(getModelId(m));
    }
  }

  updateConfig((raw) => {
    raw.providers = (raw.providers as any[]).filter((p: any) => p.id !== id);
    if (cascade) {
      // Cascade: strip pool entries referencing removed ids from every
      // alias. Aliases whose pool becomes empty are left as empty pools
      // so the router returns a clear error rather than silently dropping
      // the alias name.
      pruneAliasPools(raw, removedIds);
    }
  });

  // Re-read the latest config so we can report cascading effects. When
  // cascading we still surface any aliases left with empty pools (caller
  // may want to delete them too).
  const after = getConfig();
  const orphans: { alias: string; index: number; modelId: string }[] = [];
  if (!cascade) {
    for (const [aliasName, pool] of Object.entries(after.aliases ?? {})) {
      for (let i = 0; i < pool.length; i++) {
        const mid = getAliasEntryId(pool[i]);
        if (removedIds.has(mid)) {
          orphans.push({ alias: aliasName, index: i, modelId: mid });
        }
      }
    }
  }
  const emptied: string[] = [];
  if (cascade) {
    for (const [name, pool] of Object.entries(after.aliases ?? {})) {
      if (Array.isArray(pool) && pool.length === 0) emptied.push(name);
    }
  }

  return c.json({ ok: true, orphaned: orphans, cascade, emptied });
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

// Mask a token key for list-view display. Never returns the full key from
// list endpoints — the admin copies the value once from the POST /keys
// response and after that only sees a masked prefix/last-4. This keeps
// the dashboard from being a token-leak surface (shoulder-surfing,
// screen-share, browser history).
function maskTokenKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

apiRoutes.get("/keys", (c) => {
  const config = getConfig();
  // Mask at the source so the unmasked value never crosses the wire on a
  // list fetch. POST /keys still returns the full value once so the admin
  // can copy it on creation.
  return c.json(config.tokens.map((t) => ({ ...t, key: maskTokenKey(t.key) })));
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

// --- Aliases (Model Pools) ---

apiRoutes.get("/aliases", (c) => {
  const config = getConfig();
  const aliases = config.aliases ?? {};
  // Return as array of { name, models } for the dashboard.
  return c.json(
    Object.entries(aliases).map(([name, models]) => ({ name, models }))
  );
});

// Reject pool entries that no enabled provider currently serves. Lets the
// dashboard surface a clear "these models don't exist" error at save time
// instead of letting the alias silently fail at request time.
function validateAliasPool(pool: AliasEntry[]): string | null {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "Alias must have at least one model";
  }
  const orphans = findOrphanPoolEntries(pool);
  if (orphans.length > 0) {
    return `Pool references models not served by any enabled provider: ${orphans.join(", ")}`;
  }
  return null;
}

apiRoutes.post("/aliases", async (c) => {
  const body = await c.req.json<{ name: string; models: any[] }>();
  if (!body.name) return c.json({ error: "Alias name is required" }, 400);
  if (!Array.isArray(body.models) || body.models.length === 0) {
    return c.json({ error: "Alias must have at least one model" }, 400);
  }
  const poolError = validateAliasPool(body.models);
  if (poolError) return c.json({ error: poolError }, 400);
  const config = getConfig();
  if (config.aliases?.[body.name]) {
    return c.json({ error: `Alias '${body.name}' already exists` }, 409);
  }
  updateConfig((raw) => {
    const aliases = (raw.aliases ?? {}) as Record<string, any[]>;
    aliases[body.name] = body.models;
    raw.aliases = aliases;
  });
  return c.json({ name: body.name, models: body.models }, 201);
});

apiRoutes.put("/aliases/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ models?: any[]; name?: string }>();
  const config = getConfig();
  if (!config.aliases?.[name]) {
    return c.json({ error: "Alias not found" }, 404);
  }

  // When renaming, validate that the new name doesn't collide with an
  // existing alias (other than the one being renamed). When updating pool,
  // validate that all entries resolve to live providers.
  const newName = body.name && body.name !== name ? body.name : name;
  if (newName !== name && config.aliases?.[newName]) {
    return c.json({ error: `Alias '${newName}' already exists` }, 409);
  }

  const newPool = body.models ?? config.aliases[name];
  const poolError = validateAliasPool(newPool);
  if (poolError) return c.json({ error: poolError }, 400);

  updateConfig((raw) => {
    const aliases = (raw.aliases ?? {}) as Record<string, any[]>;
    if (newName !== name) {
      // Move: copy with new key, then drop old key. Using the freshly
      // validated `newPool` (not the pre-rename `aliases[name]`) ensures
      // the rename path applies pool updates in the same transaction.
      aliases[newName] = newPool;
      delete aliases[name];
    } else {
      aliases[name] = newPool;
    }
    raw.aliases = aliases;
  });
  return c.json({ ok: true, name: newName });
});

apiRoutes.delete("/aliases/:name", async (c) => {
  const name = c.req.param("name");
  updateConfig((raw) => {
    const aliases = (raw.aliases ?? {}) as Record<string, any[]>;
    delete aliases[name];
    raw.aliases = aliases;
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

import { serve } from "@hono/node-server";
import { loadConfig, watchConfig } from "./config.js";
import { initDb, getValidAdminToken, getAdminTokenInfo, createAdminToken, migrateLegacyLogStorageSetting } from "./store/db.js";
import { runRetentionCleanup } from "./store/log-writer.js";
import { startRetentionScheduler } from "./scheduler.js";
import { createServer } from "./server.js";

const config = loadConfig();
initDb();
migrateLegacyLogStorageSetting();

{
  let token = getValidAdminToken();
  if (!token) { token = createAdminToken(); console.log(`[tokenparty] New admin token generated`); }
  const info = getAdminTokenInfo()!;
  console.log(`[tokenparty] Admin token: ${info.token} (expires: ${new Date(info.expires_at).toISOString().slice(0, 10)})`);
}

{
  // One-shot retention pass at boot so a fresh deploy catches up on any
  // days that piled up while the gateway was down. Quiet unless work
  // was actually done.
  const result = runRetentionCleanup();
  if (result.deletedDays.length > 0) {
    console.log(`[tokenparty] Initial retention cleanup (${result.reason}): deleted ${result.deletedDays.length} day(s), freed ${result.freedMB}MB`);
  }
}

const app = createServer();

watchConfig((newConfig) => {
  console.log(`[tokenparty] Config reloaded`);
});

serve(
  { fetch: app.fetch, port: config.server.port, hostname: config.server.host },
  (info) => {
    console.log(`[tokenparty] Proxy running at http://${info.address}:${info.port}`);
    console.log(`[tokenparty] OpenAI endpoint:    /v1/*`);
    console.log(`[tokenparty] Anthropic endpoint: /anthropic/*`);
    console.log(`[tokenparty] Dashboard API:      /api/*`);
    startRetentionScheduler();
  }
);

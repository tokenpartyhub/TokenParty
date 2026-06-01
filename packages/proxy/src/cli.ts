#!/usr/bin/env node
import { serve } from "@hono/node-server";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { loadConfig, watchConfig } from "./config.js";
import { initDb, getValidAdminToken, getAdminTokenInfo, createAdminToken } from "./store/db.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: tokenparty [options]

Options:
  --port <port>      Port to listen on (default: 3456)
  --host <host>      Host to bind (default: 0.0.0.0)
  --config <path>    Path to config.yaml (default: ~/.tokenparty/config.yaml)
  --token            Show current admin token
  -h, --help         Show this help message
  -v, --version      Show version

Data is stored in ~/.tokenparty/ (config, logs, database).
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkgPath = path.resolve(import.meta.dirname, "../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  console.log(`tokenparty v${pkg.version}`);
  process.exit(0);
}

const homeDir = path.join(os.homedir(), ".tokenparty");
fs.mkdirSync(homeDir, { recursive: true });

const configPath = getArg("config") ?? path.join(homeDir, "config.yaml");
const config = loadConfig(configPath);

const port = getArg("port") ? Number(getArg("port")) : config.server.port;
const host = getArg("host") ?? config.server.host;

initDb();

if (args.includes("--token")) {
  let token = getValidAdminToken();
  if (!token) token = createAdminToken();
  const info = getAdminTokenInfo()!;
  console.log(`Admin token: ${info.token}`);
  console.log(`Expires:     ${new Date(info.expires_at).toISOString().slice(0, 10)}`);
  process.exit(0);
}

function ensureAdminToken() {
  let token = getValidAdminToken();
  if (!token) {
    token = createAdminToken();
    console.log(`[tokenparty] New admin token generated`);
  }
  const info = getAdminTokenInfo()!;
  console.log(`[tokenparty] Admin token: ${info.token} (expires: ${new Date(info.expires_at).toISOString().slice(0, 10)})`);
}

ensureAdminToken();

const app = createServer();

watchConfig((newConfig) => {
  console.log(`[tokenparty] Config reloaded`);
});

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const addr = info.address === "0.0.0.0" ? "localhost" : info.address;
  console.log(`[tokenparty] Proxy running at http://${addr}:${info.port}`);
  console.log(`[tokenparty] Dashboard:          http://${addr}:${info.port}/`);
  console.log(`[tokenparty] OpenAI endpoint:    /v1/*`);
  console.log(`[tokenparty] Anthropic endpoint: /anthropic/*`);
  console.log(`[tokenparty] Config:             ${configPath}`);
});

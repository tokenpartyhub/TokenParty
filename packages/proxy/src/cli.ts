#!/usr/bin/env node
import { serve } from "@hono/node-server";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { loadConfig, watchConfig } from "./config.js";
import { initDb, getValidAdminToken, getAdminTokenInfo, createAdminToken, migrateLegacyLogStorageSetting } from "./store/db.js";
import { runRetentionCleanup } from "./store/log-writer.js";
import { startRetentionScheduler } from "./scheduler.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
const homeDir = path.join(os.homedir(), ".tokenparty");
const pidFile = path.join(homeDir, "tokenparty.pid");
const logFile = path.join(homeDir, "logs", "daemon.log");

const subcommands = new Set(["start", "stop", "restart", "status", "log", "token"]);
const command = args[0] && !args[0].startsWith("-") && subcommands.has(args[0]) ? args[0] : null;
const restArgs = command ? args.slice(1) : args;

function getArg(name: string): string | undefined {
  const idx = restArgs.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return restArgs[idx + 1];
}

if (restArgs.includes("--help") || restArgs.includes("-h")) {
  console.log(`
Usage: tokenparty [command] [options]

Commands:
  (none)             Start in foreground (default)
  start              Start in background (daemon mode)
  stop               Stop the service
  restart            Restart the service
  status             Check if the service is running
  log                Show recent daemon log output
  token              Show current admin token

Options:
  --port <port>      Port to listen on (default: 3456)
  --host <host>      Host to bind (default: 0.0.0.0)
  --config <path>    Path to config.yaml
  -h, --help         Show this help message
  -v, --version      Show version

Data is stored in ~/.tokenparty/ (config, logs, database).
`);
  process.exit(0);
}

if (restArgs.includes("--version") || restArgs.includes("-v")) {
  const pkgPath = path.resolve(import.meta.dirname, "../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  console.log(`tokenparty v${pkg.version}`);
  process.exit(0);
}

fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function writePid(pid: number) {
  fs.writeFileSync(pidFile, String(pid));
}

function removePid() {
  try { fs.unlinkSync(pidFile); } catch {}
}

function findProcessOnPort(port: number): number | null {
  try {
    const output = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: "utf-8" }).trim();
    const pids = output.split("\n").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "0.0.0.0");
  });
}

async function waitForPort(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stopExisting(port: number): Promise<boolean> {
  let killed = false;

  const pid = readPid();
  if (pid) {
    killProcess(pid);
    removePid();
    console.log(`[tokenparty] Stopped process (PID: ${pid})`);
    killed = true;
  }

  const portPid = findProcessOnPort(port);
  if (portPid && portPid !== pid) {
    killProcess(portPid);
    console.log(`[tokenparty] Stopped process on port ${port} (PID: ${portPid})`);
    killed = true;
  }

  if (killed) {
    if (!await waitForPort(port)) {
      console.error(`[tokenparty] Port ${port} still in use after timeout`);
      return false;
    }
  }

  return true;
}

// --- status ---
if (command === "status") {
  const pid = readPid();
  if (pid) {
    console.log(`tokenparty is running (PID: ${pid})`);
  } else {
    console.log("tokenparty is not running");
  }
  process.exit(0);
}

// --- stop ---
if (command === "stop") {
  const configPath = getArg("config") ?? path.join(homeDir, "config.yaml");
  let port = 3456;
  try {
    const config = loadConfig(configPath);
    port = getArg("port") ? Number(getArg("port")) : config.server.port;
  } catch {}

  const pid = readPid();
  const portPid = findProcessOnPort(port);

  if (!pid && !portPid) {
    console.log("tokenparty is not running");
    process.exit(0);
  }

  if (pid) {
    killProcess(pid);
    removePid();
    console.log(`tokenparty stopped (PID: ${pid})`);
  }
  if (portPid && portPid !== pid) {
    killProcess(portPid);
    console.log(`tokenparty stopped (PID: ${portPid}, found on port ${port})`);
  }
  process.exit(0);
}

// --- log ---
if (command === "log") {
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, "utf-8").split("\n");
    console.log(lines.slice(-50).join("\n"));
  } else {
    console.log("No daemon log found");
  }
  process.exit(0);
}

// --- Config & port resolution ---
const configPath = getArg("config") ?? path.join(homeDir, "config.yaml");
const config = loadConfig(configPath);
const port = getArg("port") ? Number(getArg("port")) : config.server.port;
const host = getArg("host") ?? config.server.host;

// --- token ---
if (command === "token") {
  initDb();
  let token = getValidAdminToken();
  if (!token) token = createAdminToken();
  const info = getAdminTokenInfo()!;
  console.log(`Admin token: ${info.token}`);
  console.log(`Expires:     ${new Date(info.expires_at).toISOString().slice(0, 10)}`);
  process.exit(0);
}

// --- restart ---
if (command === "restart") {
  (async () => {
    await stopExisting(port);
    daemonStart();
  })();
} else if (command === "start") {
  // --- start (daemon) ---
  const existing = readPid();
  if (existing) {
    console.log(`tokenparty is already running (PID: ${existing})`);
    console.log("Use 'tokenparty restart' to restart, or 'tokenparty stop' to stop.");
    process.exit(1);
  }
  daemonStart();
} else {
  // --- Default: foreground start ---
  (async () => {
    const portFree = await checkPort(port);
    if (!portFree) {
      const existingPid = findProcessOnPort(port);
      console.error(`[tokenparty] Port ${port} is already in use${existingPid ? ` (PID: ${existingPid})` : ""}`);
      console.error(`[tokenparty] Use 'tokenparty restart' to restart, or 'tokenparty stop' to stop the existing process.`);
      process.exit(1);
    }
    await foregroundStart();
  })();
}

function daemonStart() {
  // Strip the subcommand (start/restart/...) from the child argv so the
  // child runs in foreground mode. Without this, `tokenparty restart`
  // re-enters the restart branch and recursively spawns itself forever.
  const daemonArgs = process.argv.slice(1).filter((a) => a !== command);
  const out = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, TOKENPARTY_DAEMON: "1" },
  });

  child.unref();
  writePid(child.pid!);
  console.log(`tokenparty started in background (PID: ${child.pid})`);
  console.log(`Log: ${logFile}`);
  process.exit(0);
}

async function foregroundStart() {
  initDb();
  migrateLegacyLogStorageSetting();
  ensureAdminToken();

  if (process.env.TOKENPARTY_DAEMON === "1") {
    writePid(process.pid);
  }

  {
    const result = runRetentionCleanup();
    if (result.deletedDays.length > 0) {
      console.log(`[tokenparty] Initial retention cleanup (${result.reason}): deleted ${result.deletedDays.length} day(s), freed ${result.freedMB}MB`);
    }
  }

  const app = createServer();

  watchConfig(() => {
    console.log(`[tokenparty] Config reloaded`);
  });

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    const addr = info.address === "0.0.0.0" ? "localhost" : info.address;
    console.log(`[tokenparty] Proxy running at http://${addr}:${info.port}`);
    console.log(`[tokenparty] Dashboard:          http://${addr}:${info.port}/`);
    console.log(`[tokenparty] OpenAI endpoint:    /v1/*`);
    console.log(`[tokenparty] Anthropic endpoint: /anthropic/*`);
    console.log(`[tokenparty] Config:             ${configPath}`);
    startRetentionScheduler();
  });
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

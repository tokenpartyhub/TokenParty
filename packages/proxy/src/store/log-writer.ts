import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getDb, getSetting } from "./db.js";

export interface LogEntry {
  type: "request" | "response";
  timestamp: number;
  headers?: Record<string, string>;
  body?: unknown;
  streaming?: boolean;
  streamContent?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export function writeLog(requestId: string, entry: LogEntry): string {
  const config = getConfig();
  const date = new Date(entry.timestamp).toISOString().split("T")[0];
  const dir = path.join(config.server.logDir, date);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${requestId}.jsonl`;
  const filepath = path.join(dir, filename);
  fs.appendFileSync(filepath, JSON.stringify(entry) + "\n");

  return `${date}/${filename}`;
}

export function readLog(logFile: string): LogEntry[] {
  const config = getConfig();
  const filepath = path.join(config.server.logDir, logFile);
  if (!fs.existsSync(filepath)) return [];
  const lines = fs.readFileSync(filepath, "utf-8").trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

const DEFAULT_MAX_LOG_SIZE_MB = 500;

export function getLogStats(): { totalSizeMB: number; maxSizeMB: number; dayCount: number } {
  const config = getConfig();
  const logDir = config.server.logDir;
  const maxSizeMB = Number(getSetting("max_log_size_mb")) || DEFAULT_MAX_LOG_SIZE_MB;

  let totalSize = 0;
  let dayCount = 0;
  if (fs.existsSync(logDir)) {
    for (const entry of fs.readdirSync(logDir)) {
      const dayPath = path.join(logDir, entry);
      if (!fs.statSync(dayPath).isDirectory()) continue;
      dayCount++;
      for (const file of fs.readdirSync(dayPath)) {
        totalSize += fs.statSync(path.join(dayPath, file)).size;
      }
    }
  }

  return { totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100, maxSizeMB, dayCount };
}

export function cleanupLogs(): { deletedDays: string[]; freedMB: number } {
  const config = getConfig();
  const logDir = config.server.logDir;
  const maxSizeBytes = (Number(getSetting("max_log_size_mb")) || DEFAULT_MAX_LOG_SIZE_MB) * 1024 * 1024;

  if (!fs.existsSync(logDir)) return { deletedDays: [], freedMB: 0 };

  const days: { name: string; size: number }[] = [];
  for (const entry of fs.readdirSync(logDir).sort()) {
    const dayPath = path.join(logDir, entry);
    if (!fs.statSync(dayPath).isDirectory()) continue;
    let size = 0;
    for (const file of fs.readdirSync(dayPath)) {
      size += fs.statSync(path.join(dayPath, file)).size;
    }
    days.push({ name: entry, size });
  }

  let totalSize = days.reduce((s, d) => s + d.size, 0);
  const deletedDays: string[] = [];
  let freedBytes = 0;

  while (totalSize > maxSizeBytes && days.length > 1) {
    const oldest = days.shift()!;
    const dayPath = path.join(logDir, oldest.name);

    const db = getDb();
    db.prepare(`DELETE FROM request_index WHERE log_file LIKE ?`).run(`${oldest.name}/%`);
    db.prepare(`DELETE FROM usage_daily WHERE date = ?`).run(oldest.name);

    fs.rmSync(dayPath, { recursive: true, force: true });
    totalSize -= oldest.size;
    freedBytes += oldest.size;
    deletedDays.push(oldest.name);
  }

  return { deletedDays, freedMB: Math.round(freedBytes / 1024 / 1024 * 100) / 100 };
}

export function clearAllLogs(): { freedMB: number } {
  const config = getConfig();
  const logDir = config.server.logDir;

  let totalSize = 0;
  if (fs.existsSync(logDir)) {
    for (const entry of fs.readdirSync(logDir)) {
      const dayPath = path.join(logDir, entry);
      if (!fs.statSync(dayPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dayPath)) {
        totalSize += fs.statSync(path.join(dayPath, file)).size;
      }
      fs.rmSync(dayPath, { recursive: true, force: true });
    }
  }

  const db = getDb();
  db.exec(`DELETE FROM request_index`);
  db.exec(`DELETE FROM usage_daily`);

  return { freedMB: Math.round(totalSize / 1024 / 1024 * 100) / 100 };
}

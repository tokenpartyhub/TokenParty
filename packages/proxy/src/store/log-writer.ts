import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getDb } from "./db.js";
import { retentionPeriodToDays } from "../types/config.js";

export interface LogEntry {
  type: "request" | "response" | "attempt_request" | "attempt_response";
  timestamp: number;
  // Per-attempt metadata — present on attempt_request / attempt_response.
  attemptIndex?: number;
  attemptProvider?: string;
  attemptTargetUrl?: string;
  headers?: Record<string, string>;
  body?: unknown;
  streaming?: boolean;
  streamContent?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  status?: number;
}

export function writeLog(requestId: string, entry: LogEntry): string {
  const config = getConfig();
  const date = new Date(entry.timestamp).toISOString().split("T")[0];
  const dir = path.join(config.server.logDir, date);
  fs.mkdirSync(dir, { recursive: true });

  const filename = requestId + ".jsonl";
  const filepath = path.join(dir, filename);
  fs.appendFileSync(filepath, JSON.stringify(entry) + "\n");

  return date + "/" + filename;
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

// Day bucket directory layout: <logDir>/YYYY-MM-DD/<nanoid>.jsonl. We use
// the UTC date so that log entry timestamps and the bucket they land in
// agree regardless of where the host is located.
// (`writeLog` derives the bucket from the entry timestamp in UTC.)

export interface LogStats {
  totalSizeMB: number;
  maxSizeMB: number;
  dayCount: number;
  retentionPeriod: "1week" | "1month" | "2month";
}

export function getLogStats(): LogStats {
  const config = getConfig();
  const logDir = config.server.logDir;
  const maxSizeMB = config.server.retentionMaxSizeMB;

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

  return {
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    maxSizeMB,
    dayCount,
    retentionPeriod: config.server.retentionPeriod,
  };
}

export interface RetentionCleanupResult {
  // Days that were actually removed from disk + from request_index.
  deletedDays: string[];
  // Days still on disk after the run (sorted ascending by date).
  retainedDays: string[];
  // Why we deleted (if at all). Useful for logging and for the dashboard
  // to surface "size-cap kicked in" warnings separately from the daily
  // time-based sweep.
  reason: "none" | "time" | "size" | "both";
  // Bytes freed, rounded to two decimals of MB.
  freedMB: number;
}

interface DayInfo {
  name: string;
  // Parsed UTC midnight epoch ms — sortable.
  epoch: number;
  size: number;
}

// Strip the YYYY-MM-DD/ subdir and any request_index rows that point into
// it. CRUCIALLY this function does NOT touch usage_daily — the Overview
// aggregate must survive even when the per-request detail is pruned
// (those rows are tiny; we keep them forever).
function pruneDay(logDir: string, dayName: string): number {
  const dayPath = path.join(logDir, dayName);
  let size = 0;
  try {
    const st = fs.statSync(dayPath);
    if (st.isDirectory()) {
      for (const file of fs.readdirSync(dayPath)) {
        try {
          size += fs.statSync(path.join(dayPath, file)).size;
        } catch {}
      }
    }
  } catch {}

  fs.rmSync(dayPath, { recursive: true, force: true });
  const db = getDb();
  db.prepare("DELETE FROM request_index WHERE log_file LIKE ?").run(dayName + "/%");
  // NO: db.prepare("DELETE FROM usage_daily WHERE date = ?").run(dayName);
  return size;
}

// Reads the log dir and returns one entry per YYYY-MM-DD subdirectory,
// with its total file size. Skips any directory whose name doesn't
// look like a date — those are unexpected and we leave them alone.
function listDays(logDir: string): DayInfo[] {
  if (!fs.existsSync(logDir)) return [];
  const out: DayInfo[] = [];
  for (const entry of fs.readdirSync(logDir)) {
    const dayPath = path.join(logDir, entry);
    let stat: fs.Stats;
    try { stat = fs.statSync(dayPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const epoch = Date.parse(entry + "T00:00:00Z");
    if (Number.isNaN(epoch)) continue;
    let size = 0;
    for (const file of fs.readdirSync(dayPath)) {
      try {
        size += fs.statSync(path.join(dayPath, file)).size;
      } catch {}
    }
    out.push({ name: entry, epoch, size });
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}


// Rolling retention cleanup. Two phases:
//   1. Time-based — delete every YYYY-MM-DD bucket whose UTC date is
//      strictly older than (today - retentionDays). With retentionDays=7
//      and today=2026-07-09 we keep 2026-07-03 .. 2026-07-09 inclusive.
//   2. Size-based safety net — if the time-based pass leaves total size
//      above retentionMaxSizeMB * 1024^2, delete oldest-first days until
//      under the cap. Today is never pruned.
//
// usage_daily rows are intentionally NEVER touched (Overview stats
// accumulate forever). request_index rows for pruned days ARE removed
// since their backing JSONL is gone — keeping them would make the
// Requests page show phantom rows with no detail.
export function runRetentionCleanup(opts?: {
  now?: Date;
  logDir?: string;
  retentionPeriod?: "1week" | "1month" | "2month";
  retentionMaxSizeMB?: number;
}): RetentionCleanupResult {
  const config = getConfig();
  const logDir = opts?.logDir ?? config.server.logDir;
  const period = opts?.retentionPeriod ?? config.server.retentionPeriod;
  const maxSizeMB = opts?.retentionMaxSizeMB ?? config.server.retentionMaxSizeMB;

  const days = listDays(logDir);
  if (days.length === 0) {
    return { deletedDays: [], retainedDays: [], reason: "none", freedMB: 0 };
  }

  // Use UTC date so it matches the bucket naming used by writeLog().
  const now = opts?.now ?? new Date();
  const todayName = now.toISOString().slice(0, 10);
  const todayEpoch = Date.parse(todayName + "T00:00:00Z");

  const retentionDays = retentionPeriodToDays(period);
  // firstKeptEpoch is the UTC midnight of the oldest day we WANT to keep.
  // With today=2026-07-09 and retentionDays=7, that is 2026-07-03
  // 00:00:00Z. Any day earlier is deletable.
  const firstKeptEpoch = todayEpoch - (retentionDays - 1) * 86_400_000;

  const deletedDays: string[] = [];
  let freedBytes = 0;
  let totalSize = days.reduce((s, d) => s + d.size, 0);
  let reason: RetentionCleanupResult["reason"] = "none";

  // Phase 1: time-based. Prune everything strictly older than the first
  // kept day. Today is always within the window.
  const retainedDays: DayInfo[] = [];
  for (const d of days) {
    if (d.epoch < firstKeptEpoch) {
      freedBytes += pruneDay(logDir, d.name);
      totalSize -= d.size;
      deletedDays.push(d.name);
    } else {
      retainedDays.push(d);
    }
  }
  if (deletedDays.length > 0) reason = "time";

  // Phase 2: size-based safety net. Only kicks in when the time-based
  // pass alone was not enough (e.g. a single very busy day overflows
  // the cap). Walk oldest-first; never touch today.
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  while (totalSize > maxSizeBytes && retainedDays.length > 1) {
    const oldest = retainedDays.shift()!;
    if (oldest.name === todayName) {
      // We cannot prune today; put it back and stop. Without this
      // guard we would loop forever in the rare case that today alone
      // exceeds the cap.
      retainedDays.unshift(oldest);
      break;
    }
    freedBytes += pruneDay(logDir, oldest.name);
    totalSize -= oldest.size;
    deletedDays.push(oldest.name);
    // Each size-pass deletion must NOT downgrade a previous "time" or
    // "both" reason back to "size". Only set "size" if no time-phase
    // deletions occurred at all.
    if (reason === "none") reason = "size";
    else if (reason === "time") reason = "both";
  }

  return {
    deletedDays,
    retainedDays: retainedDays.map((d) => d.name),
    reason,
    freedMB: Math.round(freedBytes / 1024 / 1024 * 100) / 100,
  };
}

// Manual "Clear All Logs" — wipes everything (today included) plus the
// request_index and usage_daily. Distinct from retention cleanup, which
// preserves aggregates.
export function clearAllLogs(): { freedMB: number } {
  const config = getConfig();
  const logDir = config.server.logDir;

  let totalSize = 0;
  if (fs.existsSync(logDir)) {
    for (const entry of fs.readdirSync(logDir)) {
      const dayPath = path.join(logDir, entry);
      try {
        if (!fs.statSync(dayPath).isDirectory()) continue;
      } catch { continue; }
      for (const file of fs.readdirSync(dayPath)) {
        try { totalSize += fs.statSync(path.join(dayPath, file)).size; } catch {}
      }
      fs.rmSync(dayPath, { recursive: true, force: true });
    }
  }

  const db = getDb();
  db.exec("DELETE FROM request_index");
  db.exec("DELETE FROM usage_daily");

  return { freedMB: Math.round(totalSize / 1024 / 1024 * 100) / 100 };
}

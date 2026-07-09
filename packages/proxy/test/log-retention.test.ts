import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { _setConfigForTest } from "../src/config.js";
import { initDb, getDb } from "../src/store/db.js";
import { runRetentionCleanup } from "../src/store/log-writer.js";
import { retentionPeriodToDays } from "../src/types/config.js";
import type { Config } from "../src/types/config.js";

interface Ctx {
  dataDir: string;
  logDir: string;
}

function setupCtx(opts: { retentionPeriod?: "1week" | "1month" | "2month"; retentionMaxSizeMB?: number } = {}): Ctx {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenparty-retention-"));
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const config: Config = {
    server: {
      port: 0,
      host: "127.0.0.1",
      logDir,
      dataDir,
      upstreamTimeoutMs: 30_000,
      streamingUpstreamTimeoutMs: 300_000,
      retentionPeriod: opts.retentionPeriod ?? "1month",
      retentionMaxSizeMB: opts.retentionMaxSizeMB ?? 2048,
    },
    providers: [],
    tokens: [],
  };
  _setConfigForTest(config);
  initDb();
  return { dataDir, logDir };
}

function cleanupCtx(ctx: Ctx) {
  try { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); } catch {}
}


// Seed one day: create dir + JSONL file with a fake request, plus both a
// request_index row and a usage_daily row. Returns the log file id.
function seedDay(ctx: Ctx, dayName: string, opts: { requestCount?: number; usageCost?: number; fileSizeBytes?: number } = {}) {
  const dayDir = path.join(ctx.logDir, dayName);
  fs.mkdirSync(dayDir, { recursive: true });
  const id = `req-${dayName}-001`;
  const fileSize = opts.fileSizeBytes ?? 32;
  const jsonl = JSON.stringify({ type: "request", timestamp: 0, body: "x".repeat(fileSize) }) + "\n";
  fs.writeFileSync(path.join(dayDir, id + ".jsonl"), jsonl);

  const db = getDb();
  db.prepare(`INSERT INTO request_index (id, timestamp, log_file) VALUES (?, ?, ?)`).run(id, Date.parse(dayName + "T12:00:00Z"), dayName + "/" + id + ".jsonl");
  db.prepare(`INSERT INTO usage_daily (date, token_id, provider_id, model, request_count, cost) VALUES (?, ?, ?, ?, ?, ?)`).run(dayName, "t1", "p1", "m1", opts.requestCount ?? 1, opts.usageCost ?? 1);

  return id;
}

function listDirDays(ctx: Ctx): string[] {
  return fs.readdirSync(ctx.logDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
}

function rowsForDay(ctx: Ctx, dayName: string): { index: number; daily: number } {
  const db = getDb();
  const indexCount = (db.prepare(`SELECT COUNT(*) as c FROM request_index WHERE log_file LIKE ?`).get(dayName + "/%") as any).c;
  const dailyCount = (db.prepare(`SELECT COUNT(*) as c FROM usage_daily WHERE date = ?`).get(dayName) as any).c;
  return { index: indexCount, daily: dailyCount };
}

function totalSize(ctx: Ctx): number {
  let total = 0;
  for (const day of listDirDays(ctx)) {
    const dir = path.join(ctx.logDir, day);
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  }
  return total;
}


describe("retentionPeriodToDays", () => {
  it("maps enums to expected day counts", () => {
    assert.equal(retentionPeriodToDays("1week"), 7);
    assert.equal(retentionPeriodToDays("1month"), 30);
    assert.equal(retentionPeriodToDays("2month"), 60);
  });
});


describe("runRetentionCleanup", () => {
  let ctx: Ctx;
  afterEach(() => cleanupCtx(ctx));

  it("deletes YYYY-MM-DD buckets strictly older than (today - retentionDays)", () => {
    ctx = setupCtx({ retentionPeriod: "1week" });
    // Today (2026-07-09) anchored by `now`. Build a window of buckets:
    // today, -1d, -2d, -6d (kept), -7d (deletable), -30d (deletable).
    seedDay(ctx, "2026-07-09");
    seedDay(ctx, "2026-07-08");
    seedDay(ctx, "2026-07-07");
    seedDay(ctx, "2026-07-03"); // -6 days, still inside 1week window
    seedDay(ctx, "2026-07-02"); // -7 days; first day OUTSIDE the window
    seedDay(ctx, "2026-06-09"); // -30 days, well outside

    const result = runRetentionCleanup({ now: new Date("2026-07-09T15:00:00Z"), retentionPeriod: "1week" });
    const remaining = listDirDays(ctx);

    assert.equal(result.reason, "time");
    assert.deepEqual(result.deletedDays.sort(), ["2026-06-09", "2026-07-02"]);
    assert.deepEqual(remaining, ["2026-07-03", "2026-07-07", "2026-07-08", "2026-07-09"]);
  });
});


describe("runRetentionCleanup preserves aggregates", () => {
  let ctx: Ctx;
  afterEach(() => cleanupCtx(ctx));

  it("removes request_index rows but keeps usage_daily when detail is pruned", () => {
    ctx = setupCtx({ retentionPeriod: "1month" });
    const oldDay = "2026-05-01";
    seedDay(ctx, oldDay, { requestCount: 99, usageCost: 12.34 });
    seedDay(ctx, "2026-07-09");

    assert.equal(rowsForDay(ctx, oldDay).index, 1);
    assert.equal(rowsForDay(ctx, oldDay).daily, 1);

    runRetentionCleanup({ now: new Date("2026-07-09T12:00:00Z") });

    // request_index row was removed (backing JSONL is gone).
    assert.equal(rowsForDay(ctx, oldDay).index, 0);
    // BUT usage_daily row was NOT removed (Overview / aggregate survives).
    assert.equal(rowsForDay(ctx, oldDay).daily, 1);
    // Disk directory is gone.
    assert.equal(fs.existsSync(path.join(ctx.logDir, oldDay)), false);
  });
});


describe("runRetentionCleanup safety nets", () => {
  let ctx: Ctx;
  afterEach(() => cleanupCtx(ctx));

  it("never deletes today even when size cap is tight", () => {
    ctx = setupCtx({ retentionPeriod: "1week", retentionMaxSizeMB: 0 });
    seedDay(ctx, "2026-07-09", { fileSizeBytes: 4096 });
    seedDay(ctx, "2026-07-08", { fileSizeBytes: 4096 });
    seedDay(ctx, "2026-07-03", { fileSizeBytes: 4096 });
    seedDay(ctx, "2026-07-02", { fileSizeBytes: 4096 });

    const result = runRetentionCleanup({
      now: new Date("2026-07-09T12:00:00Z"),
      retentionPeriod: "1week",
      retentionMaxSizeMB: 0,
    });
    const remaining = listDirDays(ctx);

    assert.ok(remaining.includes("2026-07-09"), "today must survive size-cap trimming");
    assert.deepEqual(result.deletedDays.sort(), ["2026-07-02", "2026-07-03", "2026-07-08"]);
  });

  it("size-based pass only kicks in when time-based pass alone is insufficient", () => {
    // 4 in-window days each ~400 KB: time phase only removes the out-of-window
    // 2026-05-01 day, leaving ~1.6 MB which still exceeds the 1 MB cap, so the
    // size pass must additionally prune until under cap.
    ctx = setupCtx({ retentionPeriod: "2month", retentionMaxSizeMB: 1 });
    seedDay(ctx, "2026-07-09", { fileSizeBytes: 400_000 });
    seedDay(ctx, "2026-07-08", { fileSizeBytes: 400_000 });
    seedDay(ctx, "2026-07-07", { fileSizeBytes: 400_000 });
    seedDay(ctx, "2026-06-01", { fileSizeBytes: 400_000 });
    seedDay(ctx, "2026-05-01", { fileSizeBytes: 400_000 });

    const result = runRetentionCleanup({
      now: new Date("2026-07-09T12:00:00Z"),
      retentionPeriod: "2month",
      retentionMaxSizeMB: 1,
    });

    assert.ok(result.deletedDays.includes("2026-05-01"), "time-based phase must remove out-of-window 2026-05-01");
    assert.equal(result.reason, "both", "size phase must also kick in after time phase");
    assert.ok(totalSize(ctx) <= 1024 * 1024, `expected size <= 1MB, got ${totalSize(ctx)}`);
    assert.ok(listDirDays(ctx).includes("2026-07-09"), "today must survive both phases");
  });

  it("returns deletedDays=[] and reason=none when nothing is expired", () => {
    ctx = setupCtx({ retentionPeriod: "1month" });
    seedDay(ctx, "2026-07-09");
    seedDay(ctx, "2026-07-08");

    const result = runRetentionCleanup({
      now: new Date("2026-07-09T12:00:00Z"),
      retentionPeriod: "1month",
    });

    assert.deepEqual(result.deletedDays, []);
    assert.deepEqual(result.retainedDays.sort(), ["2026-07-08", "2026-07-09"]);
    assert.equal(result.reason, "none");
    assert.equal(result.freedMB, 0);
  });

  it("ignores non-date directories in the log root", () => {
    ctx = setupCtx({ retentionPeriod: "1week" });
    fs.mkdirSync(path.join(ctx.logDir, "not-a-date"));
    fs.writeFileSync(path.join(ctx.logDir, "not-a-date", "x"), "noise");
    seedDay(ctx, "2026-07-09");
    seedDay(ctx, "2026-01-01");

    runRetentionCleanup({
      now: new Date("2026-07-09T12:00:00Z"),
      retentionPeriod: "1week",
    });

    assert.equal(fs.existsSync(path.join(ctx.logDir, "not-a-date")), true);
    assert.ok(listDirDays(ctx).includes("2026-07-09"));
  });
});

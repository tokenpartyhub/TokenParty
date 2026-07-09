import { runRetentionCleanup } from "./store/log-writer.js";

// Scheduler for log retention cleanup.
//
// Wakes up once an hour and, if it has not already run today, runs
// runRetentionCleanup at the configured hour (default 03:00 local).
// We anchor on "did we run on YYYY-MM-DD?" rather than a fixed wall-clock
// interval because the gateway might be suspended (laptop sleep / VM pause)
// and wake up arbitrarily far in the future — a 24h interval would then
// drift forever.
//
// Stop with the returned function. Always call it on shutdown to avoid
// keeping the event loop alive via setInterval.

const RUN_HOUR = 3; // 03:00 local — quiet traffic window for most regions.

export function startRetentionScheduler(opts?: {
  // Override for tests — drive the "now" clock manually.
  now?: () => Date;
  // Override for tests — bypass DB / logDir; provide a fake cleanup.
  runOnce?: () => void;
}): () => void {
  const getNow = opts?.now ?? (() => new Date());
  const runOnce = opts?.runOnce ?? (() => {
    try {
      const result = runRetentionCleanup({ now: getNow() });
      if (result.deletedDays.length > 0) {
        console.log(
          `[tokenparty] Retention cleanup (${result.reason}): deleted ${result.deletedDays.length} day(s) [${result.deletedDays.join(", ")}], freed ${result.freedMB}MB`,
        );
      }
    } catch (e) {
      console.error("[tokenparty] Retention cleanup failed:", e);
    }
  });

  let lastRunDate = ""; // YYYY-MM-DD — empty until first run.

  const tick = () => {
    const now = getNow();
    if (now.getHours() < RUN_HOUR) return; // before the daily window
    const today = now.toISOString().slice(0, 10);
    if (today === lastRunDate) return; // already ran today
    lastRunDate = today;
    runOnce();
  };

  // Run once shortly after startup so a fresh deploy catches up immediately
  // (the gateway was probably down for hours; we want to run before the
  // first user hits it). Not the same anchor as the daily job.
  setTimeout(tick, 5_000);

  const handle = setInterval(tick, 60 * 60 * 1000); // hourly check
  return () => clearInterval(handle);
}

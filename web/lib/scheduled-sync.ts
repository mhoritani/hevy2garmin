import { acquireSyncLock, recordSyncRun } from "hevy2garmin";
import type { getDb } from "@/lib/db";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { repeatsEarlierRun } from "@/lib/sync-progress";
import { postgresSyncStore } from "@/lib/sync-store";
import { postgresLockBackend } from "@/lib/sync-lock-store";

const CAP = 50;

export type ScheduledSyncOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "ran"; ran: number; synced: number }
  | { kind: "error"; error: string; ran: number };

/**
 * One unattended pass over the backlog, run in this process: the inline path
 * of GET /api/cron/sync and the built-in auto-sync scheduler. Takes the sync
 * lock, loops the single-workout engine up to a cap, and records the run in
 * sync_log under `trigger`.
 */
export async function runScheduledSync(
  sql: ReturnType<typeof getDb>,
  trigger: string,
): Promise<ScheduledSyncOutcome> {
  // The scheduled run and a user pressing Sync are the overlap this lock is
  // actually for. Skipping when it is busy is the right answer for a cron:
  // the next tick will pick up whatever is left (#604).
  const lock = await acquireSyncLock({ backend: postgresLockBackend(sql), key: "sync" });
  if (!lock) return { kind: "skipped", reason: "another sync is running" };

  const runs: SyncOneResult[] = [];
  const seen = new Set<string>();
  try {
    for (let i = 0; i < CAP; i++) {
      // respectGrace: nobody is watching this run, so a workout that just
      // finished can wait for the watch to upload its own activity rather than
      // becoming a second copy of the same session.
      const r = await syncOneWorkout(sql, { dryRun: false, respectGrace: true });
      if (r.status === "none") break;
      // A workout already handled in this run came back: it is still pending (deferred), so
      // nothing more will move until the next run (#723).
      if (repeatsEarlierRun(seen, r)) break;
      runs.push(r);
      // Only a hard error stops the run. One refused or unresolved workout must
      // not cancel the rest of the backlog, which is how the Python loop
      // behaves at `sync.py:822-833`.
      if (r.status === "error") break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { kind: "error", error, ran: runs.length };
  } finally {
    await lock.release();
  }

  // Compared as plain strings: the engine is a separately versioned package and
  // can report statuses these pinned types do not know yet, so counting by name
  // keeps an upgrade from dropping workouts out of the tally.
  const status = (r: SyncOneResult) => r.status as string;

  const synced = runs.filter((r) => status(r) === "synced").length;
  // `processing` joins deferred and skipped: the upload may have landed, so it
  // is a workout that did not finish this run, not a failure. `failed` joins
  // the errors, because Garmin refused the import outright.
  const deferred = runs.filter(
    (r) => status(r) === "deferred" || status(r) === "skipped" || status(r) === "processing",
  ).length;
  const failed = runs.filter((r) => status(r) === "error" || status(r) === "failed").length;
  await recordSyncRun(postgresSyncStore(sql), { synced, skipped: deferred, failed }, trigger);
  return { kind: "ran", ran: runs.length, synced };
}

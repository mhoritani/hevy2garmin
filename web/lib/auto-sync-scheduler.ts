import type { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { builtinSchedulerEnabled } from "@/lib/server-schedule";
import { runScheduledSync, type ScheduledSyncOutcome } from "@/lib/scheduled-sync";

/**
 * The built-in auto-sync scheduler for a self-hosted dashboard.
 *
 * On Vercel the dashboard's Auto-sync toggle and interval drive a GitHub
 * Actions workflow on the fork. Self-hosted, nothing read them, so a server
 * without an external cron calling /api/cron/sync never synced on its own while
 * the dashboard said "On". This timer runs in the server process and syncs
 * whenever app_cache 'auto_sync' is enabled and its interval has passed since
 * the last scheduled run.
 */

/** sync_log trigger for runs started by this scheduler. */
export const SCHEDULE_TRIGGER = "schedule";
export const DEFAULT_INTERVAL_MINUTES = 120;
const TICK_MS = 60_000;

type Sql = ReturnType<typeof getDb>;

export interface AutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
}

/** Reads app_cache 'auto_sync' the way the dashboard does. */
export function parseAutoSync(value: unknown): AutoSyncConfig {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const interval = Number(v.interval_minutes);
  return {
    enabled: Boolean(v.enabled),
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MINUTES,
  };
}

/** True when auto-sync is on and a full interval has passed since `lastRunAt`. */
export function isDue(cfg: AutoSyncConfig, lastRunAt: Date | null, now: Date): boolean {
  if (!cfg.enabled) return false;
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= cfg.intervalMinutes * 60_000;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export interface TickDeps {
  sql: Sql;
  now: Date;
  /** The last run this process started, recorded or not (a skipped or failed run leaves no sync_log row). */
  lastAttemptAt: Date | null;
  run?: (sql: Sql, trigger: string) => Promise<ScheduledSyncOutcome>;
}

export type TickResult = { ran: false } | { ran: true; outcome: ScheduledSyncOutcome };

/** One scheduler check: read the setting and the last scheduled run, and sync if due. */
export async function schedulerTick({ sql, now, lastAttemptAt, run = runScheduledSync }: TickDeps): Promise<TickResult> {
  const [cfgRows, logRows] = await Promise.all([
    sql`SELECT value FROM app_cache WHERE key = 'auto_sync' LIMIT 1`,
    sql`SELECT max(time) AS last FROM sync_log WHERE trigger = ${SCHEDULE_TRIGGER}`,
  ]);
  const cfg = parseAutoSync(cfgRows[0]?.value);
  const logged = logRows[0]?.last ? new Date(logRows[0].last) : null;
  if (!isDue(cfg, latest(logged, lastAttemptAt), now)) return { ran: false };
  return { ran: true, outcome: await run(sql, SCHEDULE_TRIGGER) };
}

function describe(outcome: ScheduledSyncOutcome): string {
  switch (outcome.kind) {
    case "skipped":
      return `skipped: ${outcome.reason}`;
    case "error":
      return `failed after ${outcome.ran} workout(s): ${outcome.error}`;
    default:
      return `${outcome.synced} synced of ${outcome.ran} processed`;
  }
}

const STARTED = Symbol.for("hevy2garmin.autoSyncScheduler");

/**
 * Starts the once-a-minute check in this process. Idempotent, and a no-op in
 * demo mode or when builtinSchedulerEnabled() says something else owns the schedule.
 */
export function startAutoSyncScheduler(): void {
  if (!builtinSchedulerEnabled() || demoMode()) return;
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTED]) return;
  g[STARTED] = true;

  let busy = false;
  let lastAttemptAt: Date | null = null;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Imported lazily so a server without DATABASE_URL starts cleanly; the
      // tick then finds nothing to do until one is configured.
      const { getDb } = await import("@/lib/db");
      let sql: Sql;
      try {
        sql = getDb();
      } catch {
        return;
      }
      const now = new Date();
      const result = await schedulerTick({ sql, now, lastAttemptAt });
      if (result.ran) {
        lastAttemptAt = now;
        console.log(`[auto-sync] ${describe(result.outcome)}`);
      }
    } catch (err) {
      console.error(`[auto-sync] check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log("[auto-sync] built-in scheduler started; the Auto-sync toggle and interval on the dashboard control it");
}

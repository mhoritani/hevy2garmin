/**
 * The sync schedule of a self-hosted server whose cron calls /api/cron/sync
 * (H2G_SERVER_SYNC_SCHEDULE, e.g. "every 2 hours").
 *
 * The dashboard's auto-sync toggle and interval drive the GitHub Actions
 * workflow on Vercel, and the built-in scheduler (lib/auto-sync-scheduler.ts)
 * off Vercel. With this set, an external scheduler owns the schedule instead:
 * the pages show the schedule the server actually runs and hide the controls,
 * and the built-in scheduler stays off. Unset, nothing changes.
 */
export function serverSyncSchedule(): string | null {
  const s = process.env.H2G_SERVER_SYNC_SCHEDULE?.trim();
  return s ? s : null;
}

type Env = Record<string, string | undefined>;

/**
 * Whether this server's own timer runs auto-sync from the dashboard's toggle and
 * interval. Off on Vercel (GitHub Actions does it), when an external scheduler
 * owns the schedule (H2G_SERVER_SYNC_SCHEDULE), and with H2G_BUILTIN_SCHEDULER=off.
 */
export function builtinSchedulerEnabled(env: Env = process.env): boolean {
  if (env.VERCEL) return false;
  if (env.H2G_BUILTIN_SCHEDULER?.trim().toLowerCase() === "off") return false;
  if (env.H2G_SERVER_SYNC_SCHEDULE?.trim()) return false;
  return true;
}

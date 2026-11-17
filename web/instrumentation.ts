/**
 * Runs once when the Next.js server starts. On a self-hosted Node server it
 * starts the built-in auto-sync scheduler (lib/auto-sync-scheduler.ts), which
 * decides for itself whether it applies.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAutoSyncScheduler } = await import("./lib/auto-sync-scheduler");
  startAutoSyncScheduler();
}

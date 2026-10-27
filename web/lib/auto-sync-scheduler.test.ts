import { describe, it, expect, vi } from "vitest";
import type { getDb } from "@/lib/db";
import {
  DEFAULT_INTERVAL_MINUTES,
  SCHEDULE_TRIGGER,
  isDue,
  parseAutoSync,
  schedulerTick,
} from "./auto-sync-scheduler";

vi.mock("@/lib/scheduled-sync", () => ({ runScheduledSync: vi.fn() }));

const NOW = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A sql tag that answers the two scheduler queries from fixed rows. */
function fakeSql(autoSync: unknown, lastLogged: Date | null) {
  const queries: string[] = [];
  const tag = (strings: TemplateStringsArray) => {
    const q = strings.join("?");
    queries.push(q);
    if (q.includes("app_cache")) return Promise.resolve(autoSync === undefined ? [] : [{ value: autoSync }]);
    if (q.includes("sync_log")) return Promise.resolve([{ last: lastLogged }]);
    return Promise.reject(new Error(`unexpected query: ${q}`));
  };
  return { sql: tag as unknown as ReturnType<typeof getDb>, queries };
}

describe("parseAutoSync", () => {
  it("defaults to off at the default interval when nothing is saved", () => {
    expect(parseAutoSync(undefined)).toEqual({ enabled: false, intervalMinutes: DEFAULT_INTERVAL_MINUTES });
  });

  it("reads the toggle and interval the dashboard saves", () => {
    expect(parseAutoSync({ enabled: true, interval_minutes: 30 })).toEqual({ enabled: true, intervalMinutes: 30 });
  });

  it("falls back to the default for a missing or nonsense interval", () => {
    expect(parseAutoSync({ enabled: true, interval_minutes: "x" }).intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(parseAutoSync({ enabled: true, interval_minutes: 0 }).intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });
});

describe("isDue", () => {
  const on = { enabled: true, intervalMinutes: 60 };

  it("never runs while auto-sync is off", () => {
    expect(isDue({ ...on, enabled: false }, null, NOW)).toBe(false);
  });

  it("runs straight away when there has been no scheduled run yet", () => {
    expect(isDue(on, null, NOW)).toBe(true);
  });

  it("waits a full interval after the last run", () => {
    expect(isDue(on, minutesAgo(59), NOW)).toBe(false);
    expect(isDue(on, minutesAgo(60), NOW)).toBe(true);
  });
});

describe("schedulerTick", () => {
  it("does nothing while auto-sync is off", async () => {
    const run = vi.fn();
    const { sql } = fakeSql({ enabled: false }, null);
    expect(await schedulerTick({ sql, now: NOW, lastAttemptAt: null, run })).toEqual({ ran: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a pass under the schedule trigger once the interval has passed", async () => {
    const outcome = { kind: "ran", ran: 1, synced: 1 } as const;
    const run = vi.fn(async () => outcome);
    const { sql } = fakeSql({ enabled: true, interval_minutes: 120 }, minutesAgo(121));
    expect(await schedulerTick({ sql, now: NOW, lastAttemptAt: null, run })).toEqual({ ran: true, outcome });
    expect(run).toHaveBeenCalledWith(sql, SCHEDULE_TRIGGER);
  });

  it("counts from the last logged scheduled run, so a restart does not sync again early", async () => {
    const run = vi.fn();
    const { sql, queries } = fakeSql({ enabled: true, interval_minutes: 120 }, minutesAgo(30));
    expect(await schedulerTick({ sql, now: NOW, lastAttemptAt: null, run })).toEqual({ ran: false });
    expect(run).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes("sync_log") && q.includes("trigger"))).toBe(true);
  });

  it("counts from an unlogged attempt in this process, so a skipped or failed run is not retried every minute", async () => {
    const run = vi.fn();
    const { sql } = fakeSql({ enabled: true, interval_minutes: 120 }, minutesAgo(500));
    expect(await schedulerTick({ sql, now: NOW, lastAttemptAt: minutesAgo(5), run })).toEqual({ ran: false });
    expect(run).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import type { getDb } from "@/lib/db";
import {
  DEFAULT_INTERVAL_MINUTES,
  SCHEDULE_TRIGGER,
  isDue,
  parseAutoSync,
  schedulerTick,
  schedulerProfileTicks,
} from "./auto-sync-scheduler";
import { activeProfileId } from "./profile-context";

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

describe("scheduled profiles", () => {
  const profiles = [{ id: "first", name: "First" }, { id: "second", name: "Second" }];
  const sql = fakeSql({ enabled: true, interval_minutes: 30 }, null).sql;

  it("passes each profile its own previous attempt and context", async () => {
    const lastAttempts = new Map([["first", minutesAgo(5)]]);
    const seen: string[] = [];
    const tick = vi.fn(async (deps) => {
      const id = await activeProfileId();
      seen.push(id);
      expect(deps.lastAttemptAt).toEqual(id === "first" ? minutesAgo(5) : null);
      return id === "first" ? { ran: false } as const : { ran: true, outcome: { kind: "ran", ran: 1, synced: 1 } } as const;
    });
    await schedulerProfileTicks({ profiles, now: NOW, lastAttempts, getSql: () => sql, tick });
    expect(seen).toEqual(["first", "second"]);
    expect(lastAttempts.get("first")).toEqual(minutesAgo(5));
    expect(lastAttempts.get("second")).toEqual(NOW);
  });

  it("continues with the second profile when the first fails", async () => {
    const lastAttempts = new Map<string, Date>();
    const seen: string[] = [];
    const tick = vi.fn(async () => {
      const id = await activeProfileId();
      seen.push(id);
      if (id === "first") throw new Error("Reconnect this account");
      return { ran: true, outcome: { kind: "ran", ran: 1, synced: 1 } } as const;
    });
    const outcomes = await schedulerProfileTicks({ profiles, now: NOW, lastAttempts, getSql: () => sql, tick });
    expect(seen).toEqual(["first", "second"]);
    expect(outcomes[0].error).toBe("Reconnect this account");
    expect(outcomes[1].result?.ran).toBe(true);
    expect(lastAttempts.get("first")).toEqual(NOW);
  });

  it("honours a thirty-minute interval for each account", async () => {
    const run = vi.fn(async () => ({ kind: "ran", ran: 0, synced: 0 }) as const);
    const lastAttempts = new Map([["first", minutesAgo(29)], ["second", minutesAgo(30)]]);
    await schedulerProfileTicks({ profiles, now: NOW, lastAttempts, getSql: () => sql,
      tick: (deps) => schedulerTick({ ...deps, run }) });
    expect(run).toHaveBeenCalledOnce();
  });
});

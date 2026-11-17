import { describe, it, expect, afterEach } from "vitest";
import { builtinSchedulerEnabled, serverSyncSchedule } from "./server-schedule";

const ENV = process.env.H2G_SERVER_SYNC_SCHEDULE;
afterEach(() => {
  if (ENV === undefined) delete process.env.H2G_SERVER_SYNC_SCHEDULE;
  else process.env.H2G_SERVER_SYNC_SCHEDULE = ENV;
});

describe("serverSyncSchedule", () => {
  it("is null when unset or blank, so the toggle stays", () => {
    delete process.env.H2G_SERVER_SYNC_SCHEDULE;
    expect(serverSyncSchedule()).toBeNull();
    process.env.H2G_SERVER_SYNC_SCHEDULE = "   ";
    expect(serverSyncSchedule()).toBeNull();
  });

  it("returns the schedule text, trimmed", () => {
    process.env.H2G_SERVER_SYNC_SCHEDULE = " every 2 hours ";
    expect(serverSyncSchedule()).toBe("every 2 hours");
  });
});

describe("builtinSchedulerEnabled", () => {
  it("is on for a plain self-hosted server", () => {
    expect(builtinSchedulerEnabled({})).toBe(true);
  });

  it("is off on Vercel, where GitHub Actions runs the schedule", () => {
    expect(builtinSchedulerEnabled({ VERCEL: "1" })).toBe(false);
  });

  it("is off when an external scheduler owns the schedule", () => {
    expect(builtinSchedulerEnabled({ H2G_SERVER_SYNC_SCHEDULE: "every 2 hours" })).toBe(false);
    expect(builtinSchedulerEnabled({ H2G_SERVER_SYNC_SCHEDULE: "  " })).toBe(true);
  });

  it("is off with H2G_BUILTIN_SCHEDULER=off, in any case", () => {
    expect(builtinSchedulerEnabled({ H2G_BUILTIN_SCHEDULER: "OFF" })).toBe(false);
    expect(builtinSchedulerEnabled({ H2G_BUILTIN_SCHEDULER: "on" })).toBe(true);
  });
});

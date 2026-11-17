import { beforeEach, describe, expect, it, vi } from "vitest";
import { withProfile, activeProfileId } from "./profile-context";

const state = vi.hoisted(() => ({ fail: false, urls: [] as string[] }));
vi.mock("./profiles", () => ({ activeProfile: async () => ({ id: await activeProfileId(), name: "Test" }) }));
vi.mock("./db", () => ({ getDb: () => async () => [] }));
vi.mock("garmin-auth", () => ({
  DBTokenStore: class { constructor(readonly url: string) {} },
  GarminAuth: class {
    constructor(readonly options: { store: { url: string } }) {}
    async client() {
      state.urls.push(this.options.store.url);
      if (state.fail) { state.fail = false; throw new Error("Expired token"); }
      return { url: this.options.store.url };
    }
  },
}));
import { getGarminClient, resetGarminClient } from "./garmin-upload";

const first = "8b1b9af0-ddc8-4e4b-8209-4d436f93bb0e";
const second = "9b1b9af0-ddc8-4e4b-8209-4d436f93bb0e";
beforeEach(() => { resetGarminClient(); state.urls.length = 0; state.fail = false; });

describe("cached Garmin clients belong to one profile", () => {
  it("never reuses one account's client for the other account", async () => {
    const a = await withProfile(first, () => getGarminClient("postgres://test"));
    const b = await withProfile(second, () => getGarminClient("postgres://test"));
    expect(a).not.toBe(b);
    expect(await withProfile(first, () => getGarminClient("postgres://test"))).toBe(a);
    expect(state.urls).toHaveLength(2);
    expect(new URL(state.urls[0]).searchParams.get("options")).not.toBe(new URL(state.urls[1]).searchParams.get("options"));
    resetGarminClient(first);
    expect(await withProfile(second, () => getGarminClient("postgres://test"))).toBe(b);
    expect(await withProfile(first, () => getGarminClient("postgres://test"))).not.toBe(a);
  });

  it("does not cache a failed authentication attempt", async () => {
    state.fail = true;
    await expect(withProfile(first, () => getGarminClient("postgres://test"))).rejects.toThrow("Expired token");
    await expect(withProfile(first, () => getGarminClient("postgres://test"))).resolves.toBeTruthy();
  });
});

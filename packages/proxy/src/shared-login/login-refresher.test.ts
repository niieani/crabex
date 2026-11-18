import { describe, expect, it } from "vite-plus/test";

import type { LoginSource, LoginStatus } from "./login.ts";
import {
  createLoginRefresher,
  RENEW_BEFORE_EXPIRY_MS,
  RETRY_AFTER_FAILURE_MS,
} from "./login-refresher.ts";

const HOUR = 3_600_000;
const START = Date.parse("2030-01-01T00:00:00Z");

/** A login whose expiry the test controls, and a renewal that may move it. */
function fixture(expiresInMs: number) {
  let now = START;
  let expiresAt = START + expiresInMs;
  let state: LoginStatus["state"] = "ready";
  let renewals = 0;
  let renew: () => Promise<void> = async () => {
    renewals += 1;
    expiresAt = now + 240 * HOUR;
  };
  const login: LoginSource = {
    status: async () => ({
      state: expiresAt <= now && state === "ready" ? "expired" : state,
      path: "auth.json",
      expiresAt: state === "missing" ? undefined : new Date(expiresAt).toISOString(),
      detail: state,
    }),
    credential: async () => ({ accessToken: "t", accountId: "a" }),
  };
  const refresher = createLoginRefresher({
    login,
    renew: () => renew(),
    now: () => now,
    log: () => {},
  });
  return {
    refresher,
    advance: (ms: number) => {
      now += ms;
    },
    setState: (next: LoginStatus["state"]) => {
      state = next;
    },
    setRenew: (next: () => Promise<void>) => {
      renew = next;
    },
    /** The default renewal, which moves the expiry like a real refresh. */
    renew: () => {
      renewals += 1;
      expiresAt = now + 240 * HOUR;
      return Promise.resolve();
    },
    renewals: () => renewals,
    expiresAt: () => expiresAt,
    now: () => now,
  };
}

describe("login refresher", () => {
  it("leaves a login alone while it has more than a day left, so the host's Codex renews first", async () => {
    const { refresher, renewals } = fixture(RENEW_BEFORE_EXPIRY_MS + HOUR);
    await refresher.check();
    expect(renewals()).toBe(0);
    expect(refresher.state()).toEqual({});
  });

  it("renews a login close to expiry and records it", async () => {
    const { refresher, renewals, now } = fixture(RENEW_BEFORE_EXPIRY_MS - HOUR);
    await refresher.check();
    expect(renewals()).toBe(1);
    expect(refresher.state()).toEqual({ lastRenewedAt: new Date(now()).toISOString() });
  });

  it("renews an expired login", async () => {
    const { refresher, renewals } = fixture(-HOUR);
    await refresher.check();
    expect(renewals()).toBe(1);
  });

  it("does nothing when another Codex renewed the login in the meantime", async () => {
    const f = fixture(RENEW_BEFORE_EXPIRY_MS - HOUR);
    await f.refresher.check();
    await f.refresher.check();
    expect(f.renewals()).toBe(1);
  });

  it("reports a renewal that left the login unchanged, and waits before retrying", async () => {
    const f = fixture(RENEW_BEFORE_EXPIRY_MS - HOUR);
    let attempts = 0;
    f.setRenew(async () => {
      attempts += 1;
    });
    await f.refresher.check();
    expect(f.refresher.state()).toEqual({
      lastFailedAt: new Date(f.now()).toISOString(),
      error: expect.stringContaining("did not renew"),
    });

    f.advance(RETRY_AFTER_FAILURE_MS - 1);
    await f.refresher.check();
    expect(attempts).toBe(1);
    f.advance(1);
    await f.refresher.check();
    expect(attempts).toBe(2);
  });

  it("judges by the login: a renewal that moved the expiry counts, even if app-server erred", async () => {
    const f = fixture(-HOUR);
    const working = f.renew;
    f.setRenew(async () => {
      await working();
      throw new Error("workspace routing discovery failed");
    });
    await f.refresher.check();
    expect(f.refresher.state()).toEqual({ lastRenewedAt: new Date(f.now()).toISOString() });
  });

  it("reports a renewal that failed", async () => {
    const f = fixture(-HOUR);
    f.setRenew(async () => {
      throw new Error("app-server exited");
    });
    await f.refresher.check();
    expect(f.refresher.state().error).toContain("app-server exited");
  });

  it("clears the error once a renewal succeeds", async () => {
    const f = fixture(-HOUR);
    const working = f.renew;
    f.setRenew(async () => {
      throw new Error("offline");
    });
    await f.refresher.check();
    f.setRenew(working);
    f.advance(RETRY_AFTER_FAILURE_MS);
    await f.refresher.check();
    expect(f.refresher.state()).toEqual({ lastRenewedAt: new Date(f.now()).toISOString() });
  });

  it("skips logins it cannot renew", async () => {
    const f = fixture(-HOUR);
    for (const state of ["missing", "invalid"] as const) {
      f.setState(state);
      await f.refresher.check();
    }
    expect(f.renewals()).toBe(0);
  });

  it("runs one renewal at a time", async () => {
    const f = fixture(-HOUR);
    let release: () => void = () => {};
    let attempts = 0;
    f.setRenew(
      () =>
        new Promise<void>((resolve) => {
          attempts += 1;
          release = resolve;
        }),
    );
    const first = f.refresher.check();
    const second = f.refresher.check();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
  });
});

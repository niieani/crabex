import type { LoginSource } from "./login.ts";

/**
 * Codex renews a ChatGPT access token on its next request once the last refresh is 8 days old,
 * and access tokens last 10 days. Waiting until the last day leaves the host's own Codex a day
 * to renew first. Refresh tokens are single-use, so the login is reread right before asking:
 * once another Codex has renewed it, nothing is asked. Two processes can then only collide in
 * the second it takes app-server to start, the same risk as two Codex windows sharing a login.
 */
export const RENEW_BEFORE_EXPIRY_MS = 24 * 3_600_000;
export const RETRY_AFTER_FAILURE_MS = 3_600_000;
export const CHECK_INTERVAL_MS = 5 * 60_000;

export interface RefresherState {
  lastRenewedAt?: string;
  lastFailedAt?: string;
  error?: string;
}

export interface LoginRefresher {
  /** Renews the login if it is close to expiry; never throws. */
  check(): Promise<void>;
  state(): RefresherState;
}

export interface LoginRefresherOptions {
  login: LoginSource;
  /** Asks Codex to refresh the login in its home; Codex skips it if another process already did. */
  renew: () => Promise<void>;
  now?: () => number;
  log: (line: string) => void;
}

export function createLoginRefresher(options: LoginRefresherOptions): LoginRefresher {
  const { login, renew, log } = options;
  const now = options.now ?? Date.now;
  let state: RefresherState = {};
  let failedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const attempt = async () => {
    const before = await login.status();
    if (before.state !== "ready" && before.state !== "expired") return;
    if (before.expiresAt === undefined) return;
    const expiry = Date.parse(before.expiresAt);
    if (expiry - now() > RENEW_BEFORE_EXPIRY_MS) return;
    if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_FAILURE_MS) return;

    try {
      // The login on disk is the verdict: app-server can renew it and still fail the read after.
      let renewError: unknown;
      await renew().catch((cause: unknown) => {
        renewError = cause;
      });
      const after = await login.status();
      const renewed =
        after.state === "ready" &&
        after.expiresAt !== undefined &&
        Date.parse(after.expiresAt) > expiry;
      if (!renewed)
        throw renewError instanceof Error
          ? renewError
          : new Error(
              `Codex did not renew ${after.path}. If this keeps happening, the refresh token is no longer valid: sign in to Codex again with that home.`,
            );
      if (renewError !== undefined)
        log(
          `Codex renewed the login but then reported: ${renewError instanceof Error ? renewError.message : JSON.stringify(renewError)}`,
        );
      failedAt = undefined;
      state = { lastRenewedAt: new Date(now()).toISOString() };
      log(`renewed the login; access token valid until ${after.expiresAt}`);
    } catch (cause) {
      failedAt = now();
      const error = cause instanceof Error ? cause.message : String(cause);
      state = { ...state, lastFailedAt: new Date(failedAt).toISOString(), error };
      log(`could not renew the login: ${error}`);
    }
  };

  return {
    check() {
      inFlight ??= attempt()
        .catch((cause: unknown) => {
          log(`login check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    state: () => ({ ...state }),
  };
}

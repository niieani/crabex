import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UpstreamCredential {
  accessToken: string;
  accountId: string;
}

export interface LoginStatus {
  state: "ready" | "missing" | "invalid" | "expired";
  path: string;
  expiresAt?: string;
  detail: string;
}

export interface LoginSource {
  /** Safe to show: never contains token values. */
  status(): Promise<LoginStatus>;
  credential(): Promise<UpstreamCredential>;
}

export class LoginUnavailableError extends Error {
  override readonly name = "LoginUnavailableError";
}

/**
 * Reads a Codex login on every call, so a renewal by any Codex process is picked up at once.
 * It never refreshes: renewal is left to Codex (see login-refresher.ts).
 */
export function createCodexHomeLogin(codexHome: string, now: () => number = Date.now): LoginSource {
  const path = join(codexHome, "auth.json");

  const inspect = async (): Promise<{ status: LoginStatus; credential?: UpstreamCredential }> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return {
          status: {
            state: "missing",
            path,
            detail: `No Codex login found. Run: CODEX_HOME=${codexHome} codex login --device-auth`,
          },
        };
      throw error;
    }
    const invalid = (detail: string) => ({ status: { state: "invalid" as const, path, detail } });
    let tokens: { access_token?: unknown; account_id?: unknown } | undefined;
    try {
      tokens = (JSON.parse(text) as { tokens?: typeof tokens }).tokens;
    } catch {
      return invalid("auth.json is not valid JSON");
    }
    if (typeof tokens?.access_token !== "string")
      return invalid("This Codex login is not a ChatGPT login");
    if (typeof tokens.account_id !== "string" || tokens.account_id === "")
      return invalid("This ChatGPT login has no account id");
    const expiry = tokenExpiry(tokens.access_token);
    if (expiry === undefined) return invalid("The access token could not be read");
    const expiresAt = new Date(expiry).toISOString();
    if (expiry <= now())
      return {
        status: {
          state: "expired",
          path,
          expiresAt,
          detail: `The access token has expired. Use this login with Codex to renew it, or run: CODEX_HOME=${codexHome} codex login --device-auth`,
        },
      };
    return {
      status: { state: "ready", path, expiresAt, detail: "ChatGPT login available" },
      credential: { accessToken: tokens.access_token, accountId: tokens.account_id },
    };
  };

  return {
    status: async () => (await inspect()).status,
    async credential() {
      const { status, credential } = await inspect();
      if (credential === undefined) throw new LoginUnavailableError(status.detail);
      return credential;
    },
  };
}

function tokenExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

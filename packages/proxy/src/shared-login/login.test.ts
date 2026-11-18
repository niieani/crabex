import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createCodexHomeLogin, LoginUnavailableError } from "./login.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");

function accessToken(exp: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

async function codexHome(auth?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crabex-login-"));
  if (auth !== undefined) await writeFile(join(directory, "auth.json"), JSON.stringify(auth));
  return directory;
}

const valid = (exp = NOW / 1000 + 3600) => ({
  tokens: { access_token: accessToken(exp), account_id: "account-1", refresh_token: "refresh" },
});

describe("Codex home login", () => {
  it("provides the access token and account, and reports expiry without secrets", async () => {
    const auth = valid();
    const login = createCodexHomeLogin(await codexHome(auth), () => NOW);

    expect(await login.credential()).toEqual({
      accessToken: auth.tokens.access_token,
      accountId: "account-1",
    });
    const status = await login.status();
    expect(status.state).toBe("ready");
    expect(status.expiresAt).toBe("2030-01-01T01:00:00.000Z");
    expect(JSON.stringify(status)).not.toContain(auth.tokens.access_token);
    expect(JSON.stringify(status)).not.toContain("refresh");
  });

  it("picks up a refresh written by whichever process owns the login", async () => {
    const directory = await codexHome(valid());
    const login = createCodexHomeLogin(directory, () => NOW);
    await login.credential();
    const refreshed = valid(NOW / 1000 + 7200);
    await writeFile(join(directory, "auth.json"), JSON.stringify(refreshed));
    expect((await login.credential()).accessToken).toBe(refreshed.tokens.access_token);
  });

  it.each([
    ["missing", undefined, "missing"],
    ["api key only", { auth_mode: "apikey", OPENAI_API_KEY: "key" }, "invalid"],
    ["unreadable token", { tokens: { access_token: "x", account_id: "a" } }, "invalid"],
    ["no account", { tokens: { access_token: accessToken(NOW / 1000 + 60) } }, "invalid"],
    ["expired", valid(NOW / 1000 - 60), "expired"],
  ])("fails explicitly for %s", async (_label, auth, state) => {
    const login = createCodexHomeLogin(await codexHome(auth), () => NOW);
    expect((await login.status()).state).toBe(state);
    await expect(login.credential()).rejects.toBeInstanceOf(LoginUnavailableError);
  });
});

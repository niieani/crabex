import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AppServerRenewalOptions {
  codexBin: string;
  codexHome: string;
  timeoutMs?: number;
}

const CLIENT_INFO = { name: "crabex_shared_login", title: "Crabex Shared Login", version: "1" };
const STDERR_LIMIT = 2000;

/**
 * Renews a ChatGPT login by asking `codex app-server` for an account read with a forced token
 * refresh. Codex performs the exchange and saves the result under its own file lock, so Crabex
 * never handles the refresh token. The caller decides when a refresh is due.
 */
export function createAppServerRenewal(options: AppServerRenewalOptions): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;

  return () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(options.codexBin, ["app-server"], {
        env: { ...process.env, CODEX_HOME: options.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new Error(`codex app-server did not answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

      child.on("error", (error) =>
        finish(new Error(`could not start ${options.codexBin} app-server: ${error.message}`)),
      );
      child.on("close", (code, signal) =>
        finish(
          new Error(
            `codex app-server exited (${signal ?? code}) before answering: ${stderr.trim() || "no output"}`,
          ),
        ),
      );
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: { id?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (message.error !== undefined && message.id !== undefined)
          return finish(new Error(`codex app-server: ${String(message.error.message)}`));
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        } else if (message.id === 2) {
          finish();
        }
      });

      send({ id: 1, method: "initialize", params: { clientInfo: CLIENT_INFO } });
    });
}

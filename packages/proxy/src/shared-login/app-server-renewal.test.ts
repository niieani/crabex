import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createAppServerRenewal } from "./app-server-renewal.ts";

type Behavior = "answer" | "error" | "exit" | "hang";

/** A stand-in `codex` that speaks the app-server stdio protocol and records what it receives. */
async function fakeCodex(behavior: Behavior): Promise<{ bin: string; received: string }> {
  const directory = await mkdtemp(join(tmpdir(), "crabex-fake-codex-"));
  const bin = join(directory, "codex");
  const received = join(directory, "received.jsonl");
  await writeFile(
    bin,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const behavior = ${JSON.stringify(behavior)};
const log = (value) => appendFileSync(${JSON.stringify(received)}, JSON.stringify(value) + "\\n");
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME });
if (behavior === "exit") { console.error("boom: no login"); process.exit(3); }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffered = "";
for await (const chunk of process.stdin) {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    log(message);
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
    if (message.method === "account/read") {
      if (behavior === "hang") continue;
      send({ method: "account/updated", params: {} });
      if (behavior === "error") send({ id: message.id, error: { code: -32600, message: "nope" } });
      else send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    }
  }
}
`,
  );
  await chmod(bin, 0o755);
  return { bin, received };
}

async function messages(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("app-server renewal", () => {
  it("asks app-server for an account read with a token refresh, in the shared Codex home", async () => {
    const { bin, received } = await fakeCodex("answer");
    await createAppServerRenewal({ codexBin: bin, codexHome: "/shared/home" })();

    const [start, initialize, initialized, read] = await messages(received);
    expect(start).toEqual({ argv: ["app-server"], codexHome: "/shared/home" });
    expect(initialize).toMatchObject({ method: "initialize", params: { clientInfo: {} } });
    expect(initialized).toEqual({ method: "initialized" });
    expect(read).toMatchObject({ method: "account/read", params: { refreshToken: true } });
  });

  it("fails with the app-server error", async () => {
    const { bin } = await fakeCodex("error");
    await expect(createAppServerRenewal({ codexBin: bin, codexHome: "/h" })()).rejects.toThrow(
      /nope/,
    );
  });

  it("fails with stderr when app-server exits early", async () => {
    const { bin } = await fakeCodex("exit");
    await expect(createAppServerRenewal({ codexBin: bin, codexHome: "/h" })()).rejects.toThrow(
      /boom: no login/,
    );
  });

  it("gives up after the timeout", async () => {
    const { bin } = await fakeCodex("hang");
    await expect(
      createAppServerRenewal({ codexBin: bin, codexHome: "/h", timeoutMs: 300 })(),
    ).rejects.toThrow(/did not answer/);
  });

  it("names the missing binary", async () => {
    await expect(
      createAppServerRenewal({ codexBin: "/nonexistent/codex", codexHome: "/h" })(),
    ).rejects.toThrow(/\/nonexistent\/codex/);
  });
});

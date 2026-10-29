import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const archive = resolve(process.argv.slice(2).filter((arg) => arg !== "--")[0] ?? "");
assert(archive.endsWith(".tgz"), "Provide the release .tgz path");
// Outside the checkout so workspace dependencies cannot mask missing files.
const directory = await mkdtemp(join(tmpdir(), "crabex-package-"));
const environment = { ...process.env, CODEX_HOME: join(directory, "codex") };
async function run(command: string[], cwd = directory): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(status, 0, `${command[0]} failed: ${stderr}\n${stdout}`);
  return stdout;
}
let proxy: ReturnType<typeof Bun.spawn> | undefined;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ smoke: "forwarded" }),
});
try {
  await run(["tar", "-xzf", archive]);
  const packaged = join(directory, "package");
  const manifest = await Bun.file(join(packaged, "package.json")).json();
  assert.equal(manifest.name, "crabex");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  const cli = join(packaged, manifest.bin.crabex);
  const source = await Bun.file(cli).text();
  assert(source.startsWith("#!/usr/bin/env bun\n"), "Bun shebang must survive packaging");
  for (const imported of new Bun.Transpiler({ loader: "js" }).scanImports(
    source.replace(/^#!.*\n/, ""),
  ))
    assert(
      isBuiltin(imported.path) || /^(bun:|bun$)/.test(imported.path),
      `Unbundled import: ${imported.path}`,
    );
  assert.equal(
    (await run([process.execPath, "--no-install", cli, "--version"])).trim(),
    manifest.version,
  );
  assert.match(await run([process.execPath, "--no-install", cli, "--help"]), /crabex/);
  const installation = join(directory, "consumer");
  await mkdir(installation);
  await Bun.write(join(installation, "package.json"), '{"private":true}\n');
  await run([process.execPath, "add", "--ignore-scripts", "--no-save", archive], installation);
  assert.equal(
    (
      await run([process.execPath, "x", "--no-install", "crabex", "--version"], installation)
    ).trim(),
    manifest.version,
  );
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"])
    assert(Bun.file(join(packaged, name)).size > 0, `Missing ${name}`);

  // Exercise the service installer's copy/rebundle layout without registering
  // a LaunchAgent or disturbing any proxy the developer is already using.
  const service = join(directory, "service-release");
  await mkdir(service);
  const rebuilt = await Bun.build({
    entrypoints: [cli],
    outdir: service,
    naming: "cli.mjs",
    target: "bun",
  });
  assert(rebuilt.success, rebuilt.logs.map(String).join("\n"));
  await cp(join(packaged, "dist/ui"), join(service, "ui"), { recursive: true });
  await cp(process.execPath, join(service, "bun"));
  const runtime = join(service, "bun");
  const serviceCli = join(service, "cli.mjs");
  assert.equal((await run([runtime, serviceCli, "--version"])).trim(), manifest.version);

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const log = join(directory, "proxy.log");
  proxy = Bun.spawn(
    [
      runtime,
      "--no-install",
      serviceCli,
      "proxy",
      "--listen",
      `127.0.0.1:${port}`,
      "--upstream",
      upstream.url.origin,
    ],
    { cwd: directory, env: environment, stdout: Bun.file(log), stderr: Bun.file(log) },
  );
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proxy.exitCode !== null) break;
    try {
      if ((await fetch(`${origin}/__crabex/api/proxy-config`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Listener is not ready yet. */
    }
    await Bun.sleep(50);
  }
  assert(ready, `Packaged proxy did not start: ${await Bun.file(log).text()}`);
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
  assert(
    assets.some((asset) => asset.endsWith(".js")),
    "Missing UI JavaScript",
  );
  assert(
    assets.some((asset) => asset.endsWith(".css")),
    "Missing UI stylesheet",
  );
  for (const asset of assets) assert.equal((await fetch(`${origin}${asset}`)).status, 200, asset);
  const forwarded = await fetch(`${origin}/backend-api/codex/package-smoke`);
  assert.deepEqual(await forwarded.json(), { smoke: "forwarded" });
  console.log(
    `Packed CLI, UI assets, forwarding, and copied service layout passed (${manifest.version})`,
  );
} finally {
  if (proxy) {
    proxy.kill();
    await proxy.exited;
  }
  await upstream.stop(true);
  await rm(directory, { recursive: true, force: true });
}

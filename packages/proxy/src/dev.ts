import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "../../..");
const build = Bun.spawn(["vp", "run", "build"], { cwd, stdout: "inherit", stderr: "inherit" });
const buildCode = await build.exited;
if (buildCode !== 0) process.exit(buildCode);

const children = [
  Bun.spawn(["vp", "-C", "packages/ui", "build", "--watch"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(
    [process.execPath, "--watch", "packages/proxy/src/cli.ts", "proxy", ...process.argv.slice(2)],
    { cwd, stdout: "inherit", stderr: "inherit" },
  ),
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const code = await Promise.race(children.map((child) => child.exited));
stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = code;

import { cp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "temp.local/release");
const stage = join(output, "package");
const source = await Bun.file(join(root, "packages/proxy/package.json")).json();
const workspace = await Bun.file(join(root, "package.json")).json();
const ui = await Bun.file(join(root, "packages/ui/package.json")).json();
if (source.version !== workspace.version || ui.version !== workspace.version)
  throw new Error("Workspace, CLI, and UI versions must match");

const build = Bun.spawn(["vp", "run", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) throw new Error("Build failed");
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "dist"), { recursive: true });
// Unlike the development bundle, distribution must not depend on node_modules:
// Homebrew and the service installer both copy this bundle to a new directory.
const bundled = await Bun.build({
  entrypoints: [join(root, "packages/proxy/src/cli.ts")],
  outdir: join(stage, "dist"),
  naming: "cli.mjs",
  target: "bun",
});
if (!bundled.success) throw new Error(bundled.logs.map(String).join("\n"));
await cp(join(root, "packages/ui/dist"), join(stage, "dist/ui"), { recursive: true });
for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"])
  await cp(join(root, file), join(stage, file));
await Bun.write(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "crabex",
      version: source.version,
      description: "Route models and inspect context inside Codex",
      license: "MIT",
      type: "module",
      bin: { crabex: "dist/cli.mjs" },
      files: ["dist", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"],
      engines: { bun: ">=1.3.14" },
      repository: { type: "git", url: "git+https://github.com/niieani/crabex.git" },
      homepage: "https://github.com/niieani/crabex#readme",
      bugs: { url: "https://github.com/niieani/crabex/issues" },
      publishConfig: { access: "public" },
    },
    null,
    2,
  )}\n`,
);

// Preserve the licenses of production dependencies, including their transitive
// dependencies, in the artifact that actually contains their bundled code.
const visited = new Set<string>();
const notices: string[] = [];
async function dependencyDirectory(name: string, from: string): Promise<string | undefined> {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name);
    if (await Bun.file(join(candidate, "package.json")).exists()) return realpath(candidate);
    if (dirname(current) === current) return undefined;
  }
}
async function collect(directory: string): Promise<void> {
  if (visited.has(directory)) return;
  visited.add(directory);
  const manifest = await Bun.file(join(directory, "package.json")).json();
  const licenses: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name))
      licenses.push(await readFile(join(directory, entry.name), "utf8"));
  }
  if (!licenses.length) {
    const readme = Bun.file(join(directory, "README.md"));
    if (await readme.exists()) {
      const text = await readme.text();
      const section = text.search(/^#+ .*licen[cs]e/im);
      if (section !== -1) licenses.push(text.slice(section));
    }
  }
  if (!licenses.length) throw new Error(`Missing license text for ${manifest.name}`);
  notices.push(`${manifest.name}@${manifest.version}\n${licenses.join("\n")}\n`);
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const dependency = await dependencyDirectory(name, directory);
    if (dependency) await collect(dependency);
    else if (manifest.dependencies?.[name]) throw new Error(`Missing dependency ${name}`);
  }
}
for (const path of ["packages/proxy", "packages/ui"]) {
  const directory = join(root, path);
  const manifest = await Bun.file(join(directory, "package.json")).json();
  for (const name of Object.keys(manifest.dependencies)) {
    const dependency = await dependencyDirectory(name, directory);
    if (!dependency) throw new Error(`Missing dependency ${name}`);
    await collect(dependency);
  }
}
await Bun.write(join(stage, "THIRD_PARTY_LICENSES.txt"), notices.sort().join("\n---\n\n"));
const archive = join(output, `crabex-${source.version}.tgz`);
const pack = Bun.spawn(
  [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive],
  {
    cwd: stage,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await pack.exited) !== 0) throw new Error("Package creation failed");
console.log(`Release package: ${archive}`);

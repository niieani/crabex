import { spawnSync } from "node:child_process";
import { randomUUID, X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile, rm } from "node:fs/promises";
import { basename, join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";

const DAY = 86_400_000;
const CA_BUNDLE_GRACE_MS = 7 * DAY;
/** macOS rejects TLS server certificates valid for more than 825 days, even under a user-trusted CA. */
const SERVER_CERTIFICATE_DAYS = 825;
export const MANAGED_SERVICE_ENV = "CRABEX_MANAGED_SERVICE";
export interface TlsStatus {
  enabled: boolean;
  expiresAt?: string;
  caExpiresAt?: string;
  renewalDue?: boolean;
  trusted?: boolean;
  error?: string;
}

export interface PublishedCodexCa {
  path: string;
  previous?: string;
  /** Original external bundle, never a generated output path. */
  source?: string;
}

export interface EnvironmentController {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  unset(name: string): void;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** A custom CA bundle indicates a non-native trust configuration. */
export function configuredCustomCaBundle(environment: Record<string, string>): string | undefined {
  return [environment.CODEX_CA_CERTIFICATE, environment.SSL_CERT_FILE].find(
    (value) => value !== undefined && value.trim() !== "",
  );
}

export function isManagedCodexCaPath(root: string, path: string): boolean {
  const absolute = resolve(path);
  const directory = resolve(root, "codex-ca-bundles");
  return (
    absolute === resolve(root, "codex-ca-bundle.pem") || absolute.startsWith(`${directory}${sep}`)
  );
}

export function originalCodexCaValue(
  root: string,
  current: string | undefined,
  previous?: PublishedCodexCa,
): string | undefined {
  const value = previous === undefined ? current : previous.previous;
  return value && !isManagedCodexCaPath(root, value) ? value : undefined;
}

/** Resolve inherited managed outputs back to their input, including pre-source service state. */
export function resolveCustomCaSource(
  root: string,
  environments: Record<string, string>[],
  previous?: PublishedCodexCa,
): string | undefined {
  const isManaged = (path: string) => {
    const absolute = resolve(path);
    return (
      isManagedCodexCaPath(root, path) ||
      (previous !== undefined && absolute === resolve(previous.path))
    );
  };
  const external = (path: string | undefined) =>
    path !== undefined && path.trim() !== "" && !isManaged(path) ? resolve(path) : undefined;
  const configured = environments.map(configuredCustomCaBundle).find((path) => path !== undefined);
  if (configured !== undefined && !isManaged(configured)) return resolve(configured);
  const remembered = external(previous?.source);
  if (remembered !== undefined) return remembered;
  // Older installations did not record the source. Recover it from the available
  // external variables or the original launchd value, never from our output.
  for (const environment of environments) {
    for (const path of [environment.CODEX_CA_CERTIFICATE, environment.SSL_CERT_FILE]) {
      const source = external(path);
      if (source !== undefined) return source;
    }
  }
  const original = external(previous?.previous);
  if (original !== undefined) return original;
  if (configured !== undefined || previous !== undefined)
    throw new Error(
      "Cannot determine the original custom CA source; set SSL_CERT_FILE or CODEX_CA_CERTIFICATE to the external bundle and install with --env for that variable",
    );
  return undefined;
}

export async function prepareCodexCaBundle(
  root: string,
  customCaBundle?: string,
): Promise<string | undefined> {
  if (customCaBundle === undefined) return undefined;
  const custom = await readFile(customCaBundle, "utf8");
  if (!/-----BEGIN (?:TRUSTED )?CERTIFICATE-----/.test(custom))
    throw new Error("Configured custom CA bundle contains no PEM certificate");
  const managed = await readFile(join(root, "ca.pem"), "utf8");
  const directory = join(root, "codex-ca-bundles");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.pem`);
  try {
    await writeFile(path, `${custom.trimEnd()}\n${managed.trim()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(path, { force: true });
    throw error;
  }
  return path;
}

/** Keep references, three newest bundles, and a seven-day window for inherited environments. */
export async function pruneCodexCaBundles(
  root: string,
  referencedPaths: readonly (string | undefined)[],
  environment: EnvironmentController = launchctlEnvironment(),
): Promise<void> {
  const directory = resolve(root, "codex-ca-bundles");
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`Managed CA bundle path is not a directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const protectedPaths = new Set<string>();
  for (const path of [...referencedPaths, environment.get("CODEX_CA_CERTIFICATE")]) {
    if (!path) continue;
    protectedPaths.add(resolve(path));
    try {
      protectedPaths.add(await realpath(path));
    } catch {
      // A stale external path still cannot make an in-directory file eligible.
    }
  }
  const candidates = await Promise.all(
    (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".pem"))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return { path, modified: (await stat(path)).mtimeMs };
      }),
  );
  candidates.sort(
    (left, right) => right.modified - left.modified || left.path.localeCompare(right.path),
  );
  const graceCutoff = Date.now() - CA_BUNDLE_GRACE_MS;
  for (const { path, modified } of candidates.slice(3)) {
    if (!protectedPaths.has(path) && modified < graceCutoff) await rm(path);
  }
}

export function launchctlEnvironment(): EnvironmentController {
  return {
    get(name) {
      const result = spawnSync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
      if (result.error) throw result.error;
      const value = result.stdout.trim();
      return result.status === 0 && value.length > 0 ? value : undefined;
    },
    set(name, value) {
      run("/bin/launchctl", ["setenv", name, value]);
    },
    unset(name) {
      run("/bin/launchctl", ["unsetenv", name]);
    },
  };
}

/** CODEX_CA_CERTIFICATE takes precedence over SSL_CERT_FILE in Codex. */
export function syncPublishedCodexCa(
  managed: PublishedCodexCa,
  enable: boolean,
  environment: EnvironmentController = launchctlEnvironment(),
): void {
  const current = environment.get("CODEX_CA_CERTIFICATE");
  const managedDirectory = dirname(resolve(managed.path));
  const currentIsManaged =
    current !== undefined &&
    basename(managedDirectory) === "codex-ca-bundles" &&
    isManagedCodexCaPath(dirname(managedDirectory), current);
  if (enable) {
    if (
      current !== undefined &&
      current !== managed.previous &&
      current !== managed.path &&
      !currentIsManaged
    )
      throw new Error("CODEX_CA_CERTIFICATE changed during service installation; left unchanged");
    if (current !== managed.path) environment.set("CODEX_CA_CERTIFICATE", managed.path);
  } else if (current === managed.path || currentIsManaged) {
    if (managed.previous === undefined) environment.unset("CODEX_CA_CERTIFICATE");
    else environment.set("CODEX_CA_CERTIFICATE", managed.previous);
  }
}

/** The managed LaunchAgent's worker publishes after readiness; a standalone proxy may publish now. */
export function syncProxyStartupCodexCa(
  managed: PublishedCodexCa,
  processEnvironment: Record<string, string | undefined> = process.env,
  environment: EnvironmentController = launchctlEnvironment(),
): void {
  if (processEnvironment[MANAGED_SERVICE_ENV] === "1") return;
  syncPublishedCodexCa(managed, true, environment);
}

/** Rollback restores the previous service, whereas uninstall restores the user's original value. */
export function syncCodexCaTransition(
  next: PublishedCodexCa,
  previous: PublishedCodexCa | undefined,
  forward: boolean,
  environment: EnvironmentController = launchctlEnvironment(),
): void {
  syncPublishedCodexCa(
    { path: next.path, previous: previous?.path ?? next.previous },
    forward,
    environment,
  );
}

export async function readTls(directory: string) {
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  const key = await readFile(join(directory, "key.pem"), "utf8");
  const parsed = new X509Certificate(cert);
  const publicKey = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "pem" });
  if (publicKey !== parsed.publicKey.export({ type: "spki", format: "pem" }))
    throw new Error("TLS certificate and private key do not match");
  return { cert, key };
}

export function keychainTrusted(directory: string): boolean {
  if (process.platform !== "darwin") return false;
  return (
    spawnSync(
      "/usr/bin/security",
      ["verify-cert", "-c", join(directory, "cert.pem"), "-p", "ssl", "-s", "localhost"],
      { stdio: "ignore" },
    ).status === 0
  );
}

export async function tlsStatus(directory?: string): Promise<TlsStatus> {
  if (!directory) return { enabled: false };
  try {
    const { cert } = await readTls(directory);
    const leaf = new X509Certificate(cert);
    const ca = new X509Certificate(await readFile(join(directory, "ca.pem")));
    const expiry = new Date(leaf.validTo).getTime();
    return {
      enabled: true,
      expiresAt: new Date(expiry).toISOString(),
      caExpiresAt: new Date(ca.validTo).toISOString(),
      renewalDue: expiry < Date.now() + 30 * DAY,
      trusted: keychainTrusted(directory),
    };
  } catch (error) {
    return { enabled: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ownedCa(root: string): Promise<X509Certificate> {
  const cert = new X509Certificate(await readFile(join(root, "ca.pem")));
  const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8")) as {
    fingerprint: string;
  };
  if (owner.fingerprint !== cert.fingerprint256)
    throw new Error("TLS ownership fingerprint mismatch; left unchanged");
  return cert;
}

/** Stages an immutable leaf so a failed restart can still use the previous certificate. */
export async function prepareTls(
  root: string,
  existing?: string,
  renew = false,
  trust: (root: string, directory: string) => Promise<void> = trustTls,
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await Bun.file(join(root, "ca.pem")).exists())) {
    const config = join(root, "ca.cnf");
    await writeFile(
      config,
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Crabex ${randomUUID()}\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`,
      { mode: 0o600 },
    );
    // Restrictive directory and umask keep generated keys private from creation.
    const oldMask = process.umask(0o077);
    try {
      run("/usr/bin/openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "3650",
        "-config",
        config,
        "-keyout",
        join(root, "ca-key.pem"),
        "-out",
        join(root, "ca.pem"),
      ]);
    } finally {
      process.umask(oldMask);
    }
    const ca = new X509Certificate(await readFile(join(root, "ca.pem")));
    await writeFile(join(root, "owner.json"), JSON.stringify({ fingerprint: ca.fingerprint256 }), {
      mode: 0o600,
    });
  }
  const ca = await ownedCa(root);
  if (new Date(ca.validTo).getTime() < Date.now() + 366 * DAY)
    throw new Error(
      "Local CA expires within a year; remove TLS after uninstalling and reinstall with --https to rotate it",
    );
  if (existing && !renew) {
    const status = await tlsStatus(existing);
    if (!status.error && !status.renewalDue) {
      await trust(root, existing);
      return existing;
    }
  }
  const directory = join(root, "certificates", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = join(directory, "server.cnf");
  await writeFile(
    config,
    `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=localhost\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n`,
    { mode: 0o600 },
  );
  const oldMask = process.umask(0o077);
  try {
    run("/usr/bin/openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-config",
      config,
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "server.csr"),
    ]);
    run("/usr/bin/openssl", [
      "x509",
      "-req",
      "-in",
      join(directory, "server.csr"),
      "-CA",
      join(root, "ca.pem"),
      "-CAkey",
      join(root, "ca-key.pem"),
      "-set_serial",
      `0x${randomUUID().replaceAll("-", "")}`,
      "-days",
      String(SERVER_CERTIFICATE_DAYS),
      "-extfile",
      config,
      "-extensions",
      "server",
      "-out",
      join(directory, "cert.pem"),
    ]);
    await writeFile(join(directory, "ca.pem"), await readFile(join(root, "ca.pem")), {
      mode: 0o600,
    });
    await readTls(directory);
    await trust(root, directory);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    process.umask(oldMask);
  }
}

async function trustTls(root: string, directory: string): Promise<void> {
  await ownedCa(root);
  if (keychainTrusted(directory)) return;
  console.log(
    "Installing local HTTPS trust in your login Keychain. macOS may request authorization.",
  );
  run("/usr/bin/security", [
    "add-trusted-cert",
    "-r",
    "trustRoot",
    "-p",
    "ssl",
    "-k",
    join(homedir(), "Library/Keychains/login.keychain-db"),
    join(root, "ca.pem"),
  ]);
  if (!keychainTrusted(directory))
    throw new Error("Login Keychain did not validate the local HTTPS certificate");
}

export async function removeTls(root: string): Promise<void> {
  if (!(await Bun.file(join(root, "ca.pem")).exists())) return;
  const ca = await ownedCa(root);
  const keychain = join(homedir(), "Library/Keychains/login.keychain-db");
  const fingerprint = ca.fingerprint256.replaceAll(":", "");
  const certificates = run("/usr/bin/security", ["find-certificate", "-a", "-Z", keychain]);
  try {
    run("/usr/bin/security", ["remove-trusted-cert", join(root, "ca.pem")]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("specified item could not be found"))
      throw error;
  }
  if (certificates.includes(`SHA-256 hash: ${fingerprint}`))
    run("/usr/bin/security", ["delete-certificate", "-Z", fingerprint, keychain]);
  await rm(root, { recursive: true });
}

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseCliOptions } from "../cli/options.ts";
import { install } from "./install.ts";
import { launchdServiceManager } from "./launchd.ts";
import type { ServiceManager } from "./manager.ts";
import { lockPath, ready, schedule, statePath, tlsRoot, worker } from "./operation.ts";
import { readState, withoutOptions } from "./state.ts";
import { systemdServiceManager } from "./systemd.ts";
import {
  prepareTls,
  removeTls,
  syncPublishedCodexCa,
  tlsStatus,
  type PublishedCodexCa,
} from "./tls.ts";

const COMMANDS = ["install", "uninstall", "status", "restart", "logs", "tls"];

/** The supervisor for this platform: launchd on macOS, the systemd user manager on Linux. */
export function currentServiceManager(): ServiceManager {
  if (process.platform === "darwin") return launchdServiceManager();
  if (process.platform === "linux") return systemdServiceManager();
  throw new Error(
    `Service commands support macOS (launchd) and Linux (systemd), not ${process.platform}`,
  );
}

/** The CA bundle record of the committed installation, read by the managed proxy at startup. */
export async function committedDesktopCodexCa(): Promise<PublishedCodexCa | undefined> {
  return (await readState(statePath(currentServiceManager())))?.desktopCodexCa;
}

export async function serviceCommand(
  args: string[],
  manager: ServiceManager = currentServiceManager(),
): Promise<void> {
  const [command, ...rest] = args;
  if (command === "_worker") {
    await worker(manager, rest[0]!);
    return;
  }
  if (!COMMANDS.includes(command ?? ""))
    throw new Error("Expected service install|uninstall|status|restart|logs|tls");
  if (command !== "install" && command !== "tls" && rest.length)
    throw new Error(`service ${command} takes no options`);
  if (command === "tls" && (rest.length !== 1 || !["status", "renew", "remove"].includes(rest[0]!)))
    throw new Error("Usage: service tls status|renew|remove");
  if (command === "tls" && rest[0] !== "status" && !manager.supportsHttps)
    throw new Error(`A ${manager.kind} has no managed local HTTPS`);
  const state = statePath(manager);
  if (command === "tls" && rest[0] === "status") {
    const installed = await readState(state);
    console.log(
      JSON.stringify(
        await tlsStatus(installed ? parseCliOptions(installed.args).tlsDirectory : undefined),
        null,
        2,
      ),
    );
    return;
  }
  const legacyHint = async () =>
    manager.legacy && (await readState(join(manager.legacy.root, "service.json")))
      ? `; a ${manager.legacy.label} service exists, run service install to migrate it`
      : "";
  if (command === "status") {
    const installed = await readState(state);
    if (!installed) {
      console.log(`Service is not installed${await legacyHint()}`);
      return;
    }
    console.log(manager.status());
    console.log(
      `HTTP readiness: ${(await ready(installed.origin, parseCliOptions(installed.args).tlsDirectory)) ? "ready" : "unavailable"}`,
    );
    return;
  }
  if (command === "logs") {
    console.log(manager.recentLogs());
    console.log(`Restart result logs: ${manager.logs}/restart-*.json.log`);
    return;
  }
  const lock = lockPath(manager);
  await mkdir(manager.root, { recursive: true, mode: 0o700 });
  await mkdir(manager.logs, { recursive: true, mode: 0o700 });
  await mkdir(lock).catch(() => {
    throw new Error(
      `Another service operation is active. Inspect ${manager.logs} before removing a stale lock: ${lock}`,
    );
  });
  // Scheduled operations hand the lock to their worker, which releases it.
  let scheduled = false;
  try {
    const previous = await readState(state);
    if (command === "uninstall") {
      if (!previous) {
        console.log(`Service is not installed${await legacyHint()}`);
        return;
      }
      await manager.remove();
      if (previous.desktopCodexCa !== undefined)
        syncPublishedCodexCa(previous.desktopCodexCa, false);
      if (manager.supportsHttps) await removeTls(tlsRoot(manager));
      await rm(state, { force: true });
      console.log(`Service removed; data and logs retained in ${manager.root} and ${manager.logs}`);
      return;
    }
    if (command === "tls") {
      if (rest[0] === "remove") {
        if (previous && parseCliOptions(previous.args).tlsDirectory)
          throw new Error("Uninstall the HTTPS service before removing its certificates");
        await removeTls(tlsRoot(manager));
        console.log("Managed TLS certificates and login Keychain trust removed");
        return;
      }
      if (!previous || !parseCliOptions(previous.args).tlsDirectory)
        throw new Error("Install with --https before renewing TLS");
      const directory = await prepareTls(tlsRoot(manager), undefined, true);
      const args = [...withoutOptions(previous.args, ["--tls-dir"]), "--tls-dir", directory];
      await schedule(manager, { next: { ...previous, args }, previous });
      scheduled = true;
      return;
    }
    if (command === "restart") {
      if (!previous) throw new Error(`Service is not installed${await legacyHint()}`);
      await schedule(manager, { next: previous, previous });
      scheduled = true;
      return;
    }
    await install(manager, previous, rest);
    scheduled = true;
  } finally {
    if (!scheduled) await rm(lock, { recursive: true, force: true });
  }
}

import { randomUUID } from "node:crypto";
import { cp, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { parseCliOptions } from "../cli/options.ts";
import { LEGACY_NAME } from "../config/legacy-migration.ts";
import { changedSinceCopy } from "./legacy.ts";
import type { ServiceManager } from "./manager.ts";
import {
  activateWithRollback,
  save,
  updateServiceCodexConfig,
  type Operation,
  type ServiceState,
} from "./state.ts";
import {
  linkStableCodexCa,
  pruneCodexCaBundles,
  syncCodexCaTransition,
  syncPublishedCodexCa,
} from "./tls.ts";

export const statePath = (manager: ServiceManager) => join(manager.root, "service.json");
export const lockPath = (manager: ServiceManager) => join(manager.root, "operation.lock");
export const tlsRoot = (manager: ServiceManager) => join(manager.root, "tls");

export async function ready(origin: string, tlsDirectory?: string): Promise<boolean> {
  // A rollback to a release from before the rename serves the legacy API prefix.
  for (const prefix of ["crabex", LEGACY_NAME]) {
    try {
      const response = await fetch(`${origin}/__${prefix}/api/proxy-config`, {
        signal: AbortSignal.timeout(1000),
        ...(tlsDirectory
          ? { tls: { ca: await readFile(join(tlsDirectory, "ca.pem"), "utf8") } }
          : {}),
      });
      const config = (await response.json()) as { version?: number; appsAuthRelay?: boolean };
      if (response.ok && config.version === 1 && typeof config.appsAuthRelay === "boolean")
        return true;
    } catch {
      /* try the next prefix */
    }
  }
  return false;
}

async function waitReady(
  manager: ServiceManager,
  origin: string,
  tlsDirectory?: string,
): Promise<void> {
  const port = Number(new URL(origin).port);
  for (let attempt = 0; attempt < 60; attempt++) {
    let ownsPort = false;
    try {
      const pid = manager.mainPid();
      if (pid !== undefined) ownsPort = await manager.listensOn(pid, port);
    } catch {
      /* the supervisor may still be starting the process */
    }
    if (ownsPort && (await ready(origin, tlsDirectory))) return;
    await Bun.sleep(500);
  }
  throw new Error("Proxy did not become ready within the startup deadline");
}

// Runs in a process independent of the caller, with file-backed output, before stopping any proxy.
export async function worker(manager: ServiceManager, operationPath: string): Promise<void> {
  const operation = JSON.parse(await readFile(operationPath, "utf8")) as Operation;
  const legacy = operation.legacy ? manager.legacy : undefined;
  if (operation.legacy && !legacy)
    throw new Error(`A ${manager.kind} has no legacy installation to migrate`);
  await save(`${operationPath}.started`, String(process.pid));
  // The caller confirms it received the acknowledgement before we touch the supervisor.
  for (let attempt = 0; ; attempt++) {
    if (await Bun.file(`${operationPath}.proceed`).exists()) break;
    if (attempt === 200)
      throw new Error("Restart was not acknowledged by caller; service left running");
    await Bun.sleep(50);
  }
  const tls = tlsRoot(manager);
  try {
    await activateWithRollback(operation, {
      activate: async (candidate) => {
        if (legacy) {
          await legacy.removeUnit();
          // Data written after install copied it, until the legacy proxy stopped.
          if (candidate === operation.next)
            await cp(join(legacy.root, "data"), join(manager.root, "data"), {
              recursive: true,
              force: true,
              filter: changedSinceCopy,
            }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
        await manager.start(candidate);
        await waitReady(manager, candidate.origin, parseCliOptions(candidate.args).tlsDirectory);
      },
      persist: async (candidate) => {
        const managed = operation.next.desktopCodexCa;
        // Repoint the stable link before publishing it, on commit and on rollback alike.
        if (candidate.desktopCodexCa !== undefined)
          await linkStableCodexCa(candidate.desktopCodexCa.path);
        if (managed !== undefined)
          syncCodexCaTransition(
            managed,
            operation.previous?.desktopCodexCa,
            candidate === operation.next,
          );
        if (operation.configUpdate)
          await updateServiceCodexConfig(operation.configUpdate, candidate === operation.next);
        const temporary = join(manager.root, `current-${randomUUID()}`);
        await symlink(candidate.release, temporary);
        await rename(temporary, join(manager.root, "current"));
        await save(statePath(manager), JSON.stringify(candidate, null, 2));
        if (candidate === operation.next) {
          try {
            await pruneCodexCaBundles(tls, [
              candidate.desktopCodexCa?.path,
              candidate.desktopCodexCa?.previous,
              candidate.desktopCodexCa?.source,
              operation.previous?.desktopCodexCa?.path,
              operation.previous?.desktopCodexCa?.previous,
              operation.previous?.desktopCodexCa?.source,
            ]);
          } catch (error) {
            console.warn(
              `Could not prune managed Codex CA bundles: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      },
      remove: async () => {
        if (operation.next.desktopCodexCa !== undefined)
          syncPublishedCodexCa(operation.next.desktopCodexCa, false);
        if (operation.configUpdate) await updateServiceCodexConfig(operation.configUpdate, false);
        await manager.remove();
      },
    });
    if (legacy) {
      await rm(legacy.root, { recursive: true, force: true });
      await rm(legacy.logs, { recursive: true, force: true });
      console.log(`Migrated legacy ${legacy.label} service; removed ${legacy.root}`);
    }
    console.log("Service ready", operation.next.origin);
  } finally {
    await rm(lockPath(manager), { recursive: true, force: true });
  }
}

/** Hands the operation to an independent worker and waits until it has started. */
export async function schedule(manager: ServiceManager, operation: Operation): Promise<void> {
  const path = join(manager.logs, `restart-${Date.now()}.json`);
  await save(path, JSON.stringify(operation));
  const release = (next: ServiceState) => [
    join(next.release, "bun"),
    join(next.release, "cli.mjs"),
  ];
  const handle = manager.startWorker(
    [...release(operation.next), "service", "_worker", path],
    `${path}.log`,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const failure = handle.failure();
    if (failure) throw failure;
    if (await Bun.file(`${path}.started`).exists()) {
      await save(`${path}.proceed`, "acknowledged\n");
      console.log(`Independent restart worker started. Result log: ${path}.log`);
      return;
    }
    await Bun.sleep(50);
  }
  handle.stop();
  throw new Error(`Restart worker did not acknowledge startup; inspect ${path}.log`);
}

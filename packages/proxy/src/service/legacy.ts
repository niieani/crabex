import { cp, stat } from "node:fs/promises";

import type { ServiceState } from "./state.ts";

// Copied once from the legacy root; releases, launchers, and state are rebuilt.
const LEGACY_SKIPPED = new Set(["releases", "bin", "current", "service.json", "operation.lock"]);

/** Points a legacy service's paths at their copies in the new root. */
export function relocateServiceState(state: ServiceState, from: string, to: string): ServiceState {
  const relocate = (value: unknown): unknown => {
    if (typeof value === "string")
      return value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
    if (Array.isArray(value)) return value.map(relocate);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
    return value;
  };
  return relocate(state) as ServiceState;
}

export async function copyLegacyRoot(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = source.slice(from.length + 1);
      return !LEGACY_SKIPPED.has(relative.split("/")[0]!);
    },
  });
}

/** Skips files the install already copied, so re-syncing gigabytes of captures stays fast. */
export async function changedSinceCopy(source: string, destination: string): Promise<boolean> {
  const [from, to] = await Promise.all([stat(source), stat(destination).catch(() => undefined)]);
  return (
    from.isDirectory() || to === undefined || from.size !== to.size || from.mtimeMs > to.mtimeMs
  );
}

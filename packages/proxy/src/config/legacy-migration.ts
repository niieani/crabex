import { lstat, rename } from "node:fs/promises";
import { join } from "node:path";

/** The project's former name. Startup migrations move its state once; nothing else accepts it. */
export const LEGACY_NAME = "agent-context-trimmer";
export const DATA_DIRECTORY = ".crabex";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Renames `./.agent-context-trimmer` to `./.crabex`; returns a notice when anything happened. */
export async function migrateLocalDataDirectory(cwd = process.cwd()): Promise<string | undefined> {
  const legacy = join(cwd, `.${LEGACY_NAME}`);
  const current = join(cwd, DATA_DIRECTORY);
  if (!(await exists(legacy))) return undefined;
  if (await exists(current))
    return `Both ${legacy} and ${current} exist; using ${current}. Merge or remove the legacy directory.`;
  await rename(legacy, current);
  return `Migrated ${legacy} to ${current}`;
}

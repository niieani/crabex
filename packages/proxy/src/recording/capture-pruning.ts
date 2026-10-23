import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY = 86_400_000;

export interface CaptureRetentionLimits {
  maxAgeDays: number;
  maxTotalBytes: number;
}

/**
 * Deletes capture files last written more than `maxAgeDays` ago, then the
 * oldest remaining ones while the directory exceeds `maxTotalBytes`. The file
 * being written is never deleted. Snapshots already extracted from deleted
 * captures stay in the snapshot cache, and stats are recorded at event time.
 */
export async function pruneCaptures(
  directory: string,
  limits: CaptureRetentionLimits,
  options: { keep?: string; now?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".ndjson"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    if (name === options.keep) continue;
    const fileStat = await stat(join(directory, name)).catch(() => undefined);
    if (fileStat !== undefined)
      files.push({ name, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const keptSize = options.keep
    ? ((await stat(join(directory, options.keep)).catch(() => undefined))?.size ?? 0)
    : 0;
  let total = keptSize + files.reduce((sum, file) => sum + file.size, 0);
  const deleted: string[] = [];
  for (const file of files) {
    const expired = file.mtimeMs < now - limits.maxAgeDays * DAY;
    if (!expired && total <= limits.maxTotalBytes) break;
    await rm(join(directory, file.name), { force: true });
    total -= file.size;
    deleted.push(file.name);
  }
  return deleted;
}

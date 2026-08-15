import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildSnapshots, type ContextSnapshot } from "../context/snapshot.ts";
import type { CaptureEvent } from "./capture.ts";

export interface SnapshotSource {
  list(): Promise<ContextSnapshot[]>;
}

export class FileCaptureRepository implements SnapshotSource {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async list(): Promise<ContextSnapshot[]> {
    let names: string[];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".ndjson")).sort();
    } catch (error) {
      if (isMissingDirectory(error)) return [];
      throw error;
    }
    const snapshots = (
      await Promise.all(
        names.map(async (name) =>
          buildSnapshots(parseEvents(await readFile(join(this.#directory, name), "utf8"))),
        ),
      )
    ).flat();
    return snapshots.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }
}

function parseEvents(content: string): CaptureEvent[] {
  const lines = content.split("\n");
  const completeLineCount = content.endsWith("\n") ? lines.length : lines.length - 1;
  const events: CaptureEvent[] = [];
  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const event = JSON.parse(line) as CaptureEvent;
    events.push(event);
  }
  return events;
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

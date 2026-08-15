import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildSnapshots, type ContextSnapshot } from "../context/snapshot.ts";
import type { TransformationTelemetry } from "../context/transformation.ts";
import type { CaptureEvent } from "./capture.ts";

export interface SnapshotSource {
  list(): Promise<ContextSnapshot[]>;
  transformationTelemetry(): Promise<TransformationTelemetry[]>;
}

export class FileCaptureRepository implements SnapshotSource {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async list(): Promise<ContextSnapshot[]> {
    const snapshots = (await this.#eventGroups()).flatMap(buildSnapshots);
    return snapshots.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }

  async transformationTelemetry(): Promise<TransformationTelemetry[]> {
    const telemetry = new Map<string, TransformationTelemetry>();
    for (const event of (await this.#eventGroups()).flat()) {
      for (const execution of event.transformationExecutions ?? []) {
        const current = telemetry.get(execution.transformationId) ?? {
          transformationId: execution.transformationId,
          hits: 0,
          misses: 0,
          errors: 0,
          matchCount: 0,
          lastRunAt: event.timestamp,
        };
        current.hits += execution.status === "hit" ? 1 : 0;
        current.misses += execution.status === "miss" ? 1 : 0;
        current.errors += execution.status === "error" ? 1 : 0;
        current.matchCount += execution.matchCount;
        if (event.timestamp > current.lastRunAt) current.lastRunAt = event.timestamp;
        telemetry.set(execution.transformationId, current);
      }
    }
    return [...telemetry.values()].sort((left, right) =>
      left.transformationId.localeCompare(right.transformationId),
    );
  }

  async #eventGroups(): Promise<CaptureEvent[][]> {
    let names: string[];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".ndjson")).sort();
    } catch (error) {
      if (isMissingDirectory(error)) return [];
      throw error;
    }
    return Promise.all(
      names.map(async (name) => parseEvents(await readFile(join(this.#directory, name), "utf8"))),
    );
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

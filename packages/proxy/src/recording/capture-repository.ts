import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildSnapshots, type ContextSnapshot } from "../context/snapshot.ts";
import { transformResponseCreate, type ResponseCreatePayload } from "../context/transform.ts";
import type { Transformation, TransformationTelemetry } from "../context/transformation.ts";
import type { CaptureEvent, FullCaptureEvent } from "./capture.ts";

export interface RoutingTelemetry {
  action: string;
  routeSlug?: string;
  count: number;
  lastSeenAt: string;
}

export interface SnapshotSource {
  list(): Promise<ContextSnapshot[]>;
  preview(
    snapshotId: string,
    transformations: Transformation[],
  ): Promise<ContextSnapshot | undefined>;
  transformationTelemetry(): Promise<TransformationTelemetry[]>;
  routingTelemetry(): Promise<RoutingTelemetry[]>;
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

  async routingTelemetry(): Promise<RoutingTelemetry[]> {
    const telemetry = new Map<string, RoutingTelemetry>();
    for (const event of (await this.#eventGroups()).flat()) {
      const routing = event.routing;
      if (routing === undefined) continue;
      const slug = routing.action === "routed" ? routing.routeSlugs?.[0] : undefined;
      const key = slug === undefined ? routing.action : `${routing.action}:${slug}`;
      const current = telemetry.get(key) ?? {
        action: routing.action,
        ...(slug === undefined ? {} : { routeSlug: slug }),
        count: 0,
        lastSeenAt: event.timestamp,
      };
      current.count += 1;
      if (event.timestamp > current.lastSeenAt) current.lastSeenAt = event.timestamp;
      telemetry.set(key, current);
    }
    return [...telemetry.values()].sort((left, right) =>
      `${left.action}:${left.routeSlug ?? ""}`.localeCompare(
        `${right.action}:${right.routeSlug ?? ""}`,
      ),
    );
  }

  async preview(
    snapshotId: string,
    transformations: Transformation[],
  ): Promise<ContextSnapshot | undefined> {
    for (const events of await this.#eventGroups()) {
      const previewEvents = events.map((event) => previewEvent(event, transformations));
      const snapshot = buildSnapshots(previewEvents).find((item) => item.id === snapshotId);
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
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

function previewEvent(event: CaptureEvent, transformations: Transformation[]): CaptureEvent {
  if (event.direction !== "client_to_upstream" || event.encoding !== "utf8") return event;
  if (!("payload" in event)) return event;
  let payload: ResponseCreatePayload;
  try {
    payload = JSON.parse(event.payload) as ResponseCreatePayload;
  } catch {
    return event;
  }
  if (payload.type !== "response.create") return event;
  const result = transformResponseCreate(payload, transformations, {
    harness: event.harness ?? { kind: "unknown" },
    project: event.project,
  });
  const effectivePayload = JSON.stringify(result.payload);
  const preview: FullCaptureEvent = structuredClone(event);
  delete preview.effectivePayload;
  delete preview.transformationExecutions;
  if (effectivePayload !== event.payload) preview.effectivePayload = effectivePayload;
  preview.transformationExecutions = result.executions;
  return preview;
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

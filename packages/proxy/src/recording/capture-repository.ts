import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelRouteStore } from "../config/model-route-store.ts";
import type { TransformationStore } from "../config/transformation-store.ts";
import type { UpstreamCacheStore } from "../config/upstream-cache.ts";
import {
  buildSnapshots,
  type ContextSnapshot,
  type SnapshotModelContext,
} from "../context/snapshot.ts";
import {
  transformModelDefinitions,
  transformResponseCreate,
  type ResponseCreatePayload,
} from "../context/transform.ts";
import type { Transformation, TransformationTelemetry } from "../context/transformation.ts";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import { transformModels, type ModelDefinition } from "../routing/model-list.ts";
import { modelsFixture } from "../routing/models-fixture.ts";
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

/**
 * Optional collaborators used to derive model-level catalog parts from the
 * last observed upstream /models response, viewed through the current route
 * set and transformations.
 */
export interface CaptureRepositoryCollaborators {
  upstreamCache?: UpstreamCacheStore;
  modelRoutes?: ModelRouteStore;
  transformations?: TransformationStore;
  /** Baked-in model catalog; defaults to the packaged fixture. */
  fixtureModels?: ModelDefinition[];
}

export class FileCaptureRepository implements SnapshotSource {
  readonly #directory: string;
  readonly #collaborators: CaptureRepositoryCollaborators;

  constructor(directory: string, collaborators: CaptureRepositoryCollaborators = {}) {
    this.#directory = directory;
    this.#collaborators = collaborators;
  }

  async list(): Promise<ContextSnapshot[]> {
    const models = await this.#modelContext(
      this.#collaborators.transformations?.get().transformations ?? [],
    );
    const snapshots = (await this.#eventGroups()).flatMap((events) =>
      buildSnapshots(events, models),
    );
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
    const models = await this.#modelContext(transformations);
    for (const events of await this.#eventGroups()) {
      const previewEvents = events.map((event) => previewEvent(event, transformations));
      const snapshot = buildSnapshots(previewEvents, models).find((item) => item.id === snapshotId);
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
  }

  /**
   * Resolves the observed upstream model definitions and the effective
   * definitions after routes, adjustments, and the given transformations.
   * Returns undefined when no upstream models response has been observed.
   */
  async #modelContext(
    transformations: Transformation[],
  ): Promise<SnapshotModelContext | undefined> {
    const observed = this.#collaborators.upstreamCache?.get().models?.body;
    const observedList = observedModels(observed) ?? [];
    const fixtureModels = this.#collaborators.fixtureModels ?? modelsFixture();
    const observedSlugs = new Set(observedList.map((model) => model.slug));
    // Observed upstream models win; fixture-only models are appended so their
    // strings still appear in the catalog (and can template routes).
    const original = [
      ...observedList,
      ...fixtureModels.filter((model) => !observedSlugs.has(model.slug)),
    ];
    if (original.length === 0) return undefined;
    const set = this.#collaborators.modelRoutes?.get() ?? {
      routes: [],
      adjustments: [],
      fixture_pins: [],
    };
    let effective: ModelDefinition[];
    try {
      effective = transformModels(
        { models: original },
        set.routes.map(modelRouteFromConfig),
        set.adjustments,
        { models: fixtureModels, pins: set.fixture_pins },
      ).models;
    } catch {
      // A broken route set must not break the catalog; show unadjusted models.
      effective = original;
    }
    effective = transformModelDefinitions(effective, transformations, {
      harness: { kind: "unknown" },
    }).models;
    const templates = Object.fromEntries(
      set.routes.map((route) => [route.model.slug, route.model.template_slug]),
    );
    return { original, effective, templates };
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

function observedModels(body: unknown): ModelDefinition[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const valid = models.filter(
    (model): model is ModelDefinition =>
      typeof model === "object" && model !== null && typeof model.slug === "string",
  );
  return valid.length === 0 ? undefined : valid;
}

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
import type { Transformation } from "../context/transformation.ts";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import { transformModels, type ModelDefinition } from "../routing/model-list.ts";
import { modelsFixture } from "../routing/models-fixture.ts";
import type { CaptureEvent, FullCaptureEvent } from "./capture.ts";

export interface SnapshotSource {
  list(): Promise<ContextSnapshot[]>;
  preview(
    snapshotId: string,
    transformations: Transformation[],
  ): Promise<ContextSnapshot | undefined>;
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

export interface SnapshotCacheOptions {
  /** Disk cache file: loaded on boot, saved when idle. */
  path?: string;
  /** Max snapshots kept per model/project/harness combo (default 3). */
  perCombo?: number;
  /** Max snapshots kept overall (default 50). */
  total?: number;
}

const DEFAULT_PER_COMBO = 3;
const DEFAULT_TOTAL = 50;
/** Idle delay after the last change before the snapshot cache is written. */
const SAVE_DEBOUNCE_MS = 2000;

interface SnapshotCacheFile {
  version: 1;
  savedAt: string;
  snapshots: ContextSnapshot[];
  files?: [string, ScannedFile][];
  modelSignature?: string;
}

interface ScannedFile {
  size: number;
  mtimeMs: number;
  snapshotIds: string[];
}

/** Byte ranges of a capture file's snapshot-relevant lines, up to `scanned`. */
interface LineIndex {
  scanned: number;
  lines: [start: number, end: number][];
  /** Bytes just before `scanned`, to tell an appended file from a rewritten one. */
  tail: string;
}

const EMPTY_INDEX: LineIndex = { scanned: 0, lines: [], tail: "" };
const TAIL_BYTES = 256;

/**
 * Snapshot catalog over the capture directory. Snapshots are built
 * incrementally — only capture files whose size/mtime changed are reparsed —
 * capped per model/project/harness combo and overall, and mirrored to a disk
 * cache so the UI is instant on boot and survives capture rotation.
 */
export class FileCaptureRepository implements SnapshotSource {
  readonly #directory: string;
  readonly #collaborators: CaptureRepositoryCollaborators;
  readonly #cachePath?: string;
  readonly #perCombo: number;
  readonly #total: number;
  readonly #snapshots = new Map<string, ContextSnapshot>();
  readonly #files = new Map<string, ScannedFile>();
  /** In-memory only: lets a growing live capture be rescanned from where it ended. */
  readonly #indexes = new Map<string, LineIndex>();
  #listing: Promise<ContextSnapshot[]> | undefined;
  #modelSignature: string | undefined;
  #dirty = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> | undefined;

  constructor(
    directory: string,
    collaborators: CaptureRepositoryCollaborators = {},
    cache: SnapshotCacheOptions = {},
  ) {
    this.#directory = directory;
    this.#collaborators = collaborators;
    this.#cachePath = cache.path;
    this.#perCombo = cache.perCombo ?? DEFAULT_PER_COMBO;
    this.#total = cache.total ?? DEFAULT_TOTAL;
  }

  /** Loads the disk cache written by a previous run. Call once on boot. */
  async load(): Promise<void> {
    if (this.#cachePath === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.#cachePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SnapshotCacheFile>;
      for (const snapshot of parsed.snapshots ?? []) {
        if (typeof snapshot?.id === "string") this.#snapshots.set(snapshot.id, snapshot);
      }
      for (const [name, file] of parsed.files ?? []) this.#files.set(name, file);
      this.#modelSignature = parsed.modelSignature;
      this.#prune();
    } catch {
      // A corrupt cache must not break the catalog; live data rescans anyway.
    }
  }

  async list(): Promise<ContextSnapshot[]> {
    this.#listing ??= this.#scan().finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #scan(): Promise<ContextSnapshot[]> {
    const models = await this.#modelContext(
      this.#collaborators.transformations?.get().transformations ?? [],
    );
    // Model-level parts are baked into snapshots, so a changed model context
    // (routes, transformations, observed models) invalidates scanned files.
    const signature = modelSignature(models);
    if (signature !== this.#modelSignature) {
      this.#modelSignature = signature;
      this.#files.clear();
    }

    let names: string[];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".ndjson")).sort();
    } catch (error) {
      if (isMissingDirectory(error)) names = [];
      else throw error;
    }
    // Pruned captures keep their snapshots; only their scan bookkeeping goes.
    const present = new Set(names);
    for (const name of [...this.#files.keys(), ...this.#indexes.keys()]) {
      if (present.has(name)) continue;
      this.#dirty ||= this.#files.delete(name);
      this.#indexes.delete(name);
    }
    for (const name of names) {
      const path = join(this.#directory, name);
      const fileStat = await stat(path);
      const previous = this.#files.get(name);
      if (
        previous !== undefined &&
        previous.size === fileStat.size &&
        previous.mtimeMs === fileStat.mtimeMs
      ) {
        continue;
      }
      const events = await this.#readEvents(name, fileStat.size);
      const built = buildSnapshots(events, models);
      for (const id of previous?.snapshotIds ?? []) this.#snapshots.delete(id);
      for (const snapshot of built) this.#snapshots.set(snapshot.id, snapshot);
      this.#files.set(name, {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        snapshotIds: built.map((snapshot) => snapshot.id),
      });
      this.#dirty = true;
      // Bound retained content during a cold archive scan, not just at the end.
      this.#prune();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const capped = this.#prune();
    if (this.#dirty) this.#scheduleSave();
    return capped;
  }

  async preview(
    snapshotId: string,
    transformations: Transformation[],
  ): Promise<ContextSnapshot | undefined> {
    const models = await this.#modelContext(transformations);
    // The index identifies the owning capture; previewing must not replay the archive.
    const indexed = [...this.#files].find(([, file]) => file.snapshotIds.includes(snapshotId));
    let names: string[];
    try {
      names = indexed
        ? [indexed[0]]
        : (await readdir(this.#directory)).filter((name) => name.endsWith(".ndjson")).sort();
    } catch (error) {
      if (isMissingDirectory(error)) return undefined;
      throw error;
    }
    for (const name of names) {
      const fileStat = await stat(join(this.#directory, name));
      const events = await this.#readEvents(name, fileStat.size);
      const previewEvents = events.map((event) => previewEvent(event, transformations));
      const snapshot = buildSnapshots(previewEvents, models).find((item) => item.id === snapshotId);
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
  }

  /**
   * Reads the events snapshots depend on. Captures can grow to gigabytes of
   * metadata-only lines, so the file is streamed, irrelevant lines are skipped
   * before parsing, and a file that only grew is indexed from where it ended.
   */
  async #readEvents(name: string, size: number): Promise<CaptureEvent[]> {
    const path = join(this.#directory, name);
    let index = this.#indexes.get(name) ?? EMPTY_INDEX;
    if (index.scanned > size || (await tailOf(path, index.scanned)) !== index.tail)
      index = EMPTY_INDEX;
    index = await extendLineIndex(path, index);
    this.#indexes.set(name, index);
    return readIndexedEvents(path, index);
  }

  /** Applies the combo/total caps, pruning the in-memory map to match. */
  #prune(): ContextSnapshot[] {
    const snapshots = [...this.#snapshots.values()].sort((left, right) =>
      right.timestamp.localeCompare(left.timestamp),
    );
    const perCombo = new Map<string, number>();
    const kept: ContextSnapshot[] = [];
    for (const snapshot of snapshots) {
      if (kept.length >= this.#total) break;
      const combo = comboKey(snapshot);
      const count = perCombo.get(combo) ?? 0;
      if (count >= this.#perCombo) continue;
      perCombo.set(combo, count + 1);
      kept.push(snapshot);
    }
    if (kept.length !== snapshots.length) {
      this.#snapshots.clear();
      for (const snapshot of kept) this.#snapshots.set(snapshot.id, snapshot);
      this.#dirty = true;
    }
    return kept;
  }

  #scheduleSave(): void {
    if (this.#cachePath === undefined) return;
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#dirty = false;
      this.#saving = this.#save()
        .catch(() => {})
        .finally(() => {
          this.#saving = undefined;
        });
    }, SAVE_DEBOUNCE_MS);
    this.#saveTimer.unref?.();
  }

  /** Writes the cache immediately when a save is pending; call on shutdown. */
  async flush(): Promise<void> {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    await this.#saving;
    if (this.#dirty) {
      this.#dirty = false;
      await this.#save().catch(() => {});
    }
  }

  async #save(): Promise<void> {
    if (this.#cachePath === undefined) return;
    const content: SnapshotCacheFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      files: [...this.#files],
      modelSignature: this.#modelSignature,
      snapshots: [...this.#snapshots.values()].sort((left, right) =>
        right.timestamp.localeCompare(left.timestamp),
      ),
    };
    await mkdir(dirname(this.#cachePath), { recursive: true });
    const temporary = join(
      dirname(this.#cachePath),
      `.snapshots-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(content)}\n`, "utf8");
    await rename(temporary, this.#cachePath);
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
}

function comboKey(snapshot: ContextSnapshot): string {
  return JSON.stringify([snapshot.model, snapshot.project ?? "", snapshot.harness.kind]);
}

function modelSignature(models: SnapshotModelContext | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(models ?? null))
    .digest("hex");
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

const NEWLINE = 0x0a;

/** Only these events feed snapshots; the rest are metadata-only stream events. */
function isRelevantLine(line: string): boolean {
  return (
    line.includes('"payload":') ||
    line.includes('"responseSummary":') ||
    line.includes('"errorSummary":')
  );
}

/** Scans complete lines after `index.scanned`; a trailing partial line waits for the next scan. */
async function extendLineIndex(path: string, index: LineIndex): Promise<LineIndex> {
  const lines = [...index.lines];
  const decoder = new TextDecoder();
  let offset = index.scanned;
  // Chunks of the current unfinished line, joined only once its newline arrives.
  let partial: Uint8Array[] = [];
  let partialLength = 0;
  for await (const chunk of Bun.file(path).slice(index.scanned).stream()) {
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, end);
      const line = partialLength === 0 ? piece : Buffer.concat([...partial, piece]);
      const lineStart = offset - partialLength;
      if (isRelevantLine(decoder.decode(line))) lines.push([lineStart, lineStart + line.length]);
      offset += piece.length + 1;
      partial = [];
      partialLength = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      partial.push(chunk.slice(start));
      partialLength += chunk.length - start;
      offset += chunk.length - start;
    }
  }
  const scanned = offset - partialLength;
  return { scanned, lines, tail: await tailOf(path, scanned) };
}

async function tailOf(path: string, end: number): Promise<string> {
  return Bun.file(path)
    .slice(Math.max(0, end - TAIL_BYTES), end)
    .text();
}

async function readIndexedEvents(path: string, index: LineIndex): Promise<CaptureEvent[]> {
  const events: CaptureEvent[] = [];
  const handle = await open(path, "r");
  try {
    for (const [start, end] of index.lines) {
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      events.push(JSON.parse(buffer.toString("utf8")) as CaptureEvent);
    }
  } finally {
    await handle.close();
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type UpstreamCacheKind = "models" | "configBundle";

export interface UpstreamObservation {
  fetchedAt: string;
  body: unknown;
}

export interface UpstreamCacheState {
  models?: UpstreamObservation;
  configBundle?: UpstreamObservation;
}

export interface UpstreamCacheStore {
  get(): UpstreamCacheState;
  observe(kind: UpstreamCacheKind, body: unknown): Promise<void>;
}

export async function openUpstreamCacheStore(filePath: string): Promise<UpstreamCacheStore> {
  let initial: UpstreamCacheState = {};
  try {
    initial = parseUpstreamCache(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileUpstreamCacheStore(filePath, initial);
}

export function parseUpstreamCache(value: unknown): UpstreamCacheState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("upstream cache must be an object");
  }
  const record = value as Record<string, unknown>;
  const state: UpstreamCacheState = {};
  const models = observation(record.models, "models");
  const configBundle = observation(record.configBundle, "configBundle");
  if (models !== undefined) state.models = models;
  if (configBundle !== undefined) state.configBundle = configBundle;
  return state;
}

class FileUpstreamCacheStore implements UpstreamCacheStore {
  #state: UpstreamCacheState;
  readonly #filePath: string;

  constructor(filePath: string, initial: UpstreamCacheState) {
    this.#filePath = filePath;
    this.#state = initial;
  }

  get(): UpstreamCacheState {
    return structuredClone(this.#state);
  }

  async observe(kind: UpstreamCacheKind, body: unknown): Promise<void> {
    this.#state = {
      ...this.#state,
      [kind]: { fetchedAt: new Date().toISOString(), body: structuredClone(body) },
    };
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
  }
}

function observation(value: unknown, source: string): UpstreamObservation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`upstream cache ${source} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAt !== "string" || !("body" in record)) {
    throw new Error(`upstream cache ${source} must have fetchedAt and body`);
  }
  return { fetchedAt: record.fetchedAt, body: record.body };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

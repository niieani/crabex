import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseModelRouteSet, type ModelRouteSetData } from "../routing/model-routes.ts";

export interface ModelRouteStore {
  get(): ModelRouteSetData;
  replace(set: ModelRouteSetData): Promise<void>;
}

export async function openModelRouteStore(filePath: string): Promise<ModelRouteStore> {
  let initial: ModelRouteSetData = { routes: [], adjustments: [], fixture_pins: [] };
  try {
    initial = parseModelRouteSet(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileModelRouteStore(filePath, initial);
}

class FileModelRouteStore implements ModelRouteStore {
  #set: ModelRouteSetData;
  readonly #filePath: string;

  constructor(filePath: string, initial: ModelRouteSetData) {
    this.#filePath = filePath;
    this.#set = initial;
  }

  get(): ModelRouteSetData {
    return structuredClone(this.#set);
  }

  async replace(value: ModelRouteSetData): Promise<void> {
    const set = parseModelRouteSet({ version: 1, ...value });
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...set }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
    this.#set = set;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

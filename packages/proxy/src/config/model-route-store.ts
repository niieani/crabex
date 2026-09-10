import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseModelRouteSet, type ModelRouteConfig } from "../routing/model-routes.ts";

export interface ModelRouteStore {
  get(): ModelRouteConfig[];
  replace(routes: ModelRouteConfig[]): Promise<void>;
}

export async function openModelRouteStore(filePath: string): Promise<ModelRouteStore> {
  let initial: ModelRouteConfig[] = [];
  try {
    initial = parseModelRouteSet(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileModelRouteStore(filePath, initial);
}

class FileModelRouteStore implements ModelRouteStore {
  #routes: ModelRouteConfig[];
  readonly #filePath: string;

  constructor(filePath: string, initial: ModelRouteConfig[]) {
    this.#filePath = filePath;
    this.#routes = initial;
  }

  get(): ModelRouteConfig[] {
    return structuredClone(this.#routes);
  }

  async replace(value: ModelRouteConfig[]): Promise<void> {
    const routes = parseModelRouteSet(value);
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, routes }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
    this.#routes = routes;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseModelRouteSet, type ModelRouteSetData } from "../routing/model-routes.ts";
import { validateTemplateReplacements } from "../routing/model-list.ts";

export interface ModelRouteStore {
  get(): ModelRouteSetData;
  replace(set: ModelRouteSetData): Promise<void>;
}

export async function openModelRouteStore(
  filePath: string,
  upstreamModels?: () => unknown,
): Promise<ModelRouteStore> {
  let initial: ModelRouteSetData = { routes: [], adjustments: [], fixture_pins: [] };
  try {
    initial = parseModelRouteSet(JSON.parse(await readFile(filePath, "utf8")));
    validateTemplateReplacements(initial, upstreamModels?.());
    warnLegacyToolTypes(initial);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileModelRouteStore(filePath, initial, upstreamModels);
}

class FileModelRouteStore implements ModelRouteStore {
  #set: ModelRouteSetData;
  readonly #filePath: string;
  readonly #upstreamModels?: () => unknown;

  constructor(filePath: string, initial: ModelRouteSetData, upstreamModels?: () => unknown) {
    this.#filePath = filePath;
    this.#set = initial;
    this.#upstreamModels = upstreamModels;
  }

  get(): ModelRouteSetData {
    return structuredClone(this.#set);
  }

  async replace(value: ModelRouteSetData): Promise<void> {
    const set = parseModelRouteSet({ version: 1, ...value });
    validateTemplateReplacements(set, this.#upstreamModels?.());
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...set }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
    this.#set = set;
    warnLegacyToolTypes(set);
  }
}

function warnLegacyToolTypes(set: ModelRouteSetData): void {
  for (const route of set.routes) {
    if (route.allowed_tool_types !== undefined) {
      console.warn(
        `model route "${route.model.slug}": allowed_tool_types is deprecated; use tool_policy`,
      );
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

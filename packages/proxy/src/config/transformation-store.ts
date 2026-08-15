import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Transformation, TransformationSet } from "../context/transformation.ts";

export interface TransformationStore {
  get(): TransformationSet;
  replace(set: TransformationSet): Promise<void>;
}

export async function openTransformationStore(filePath: string): Promise<TransformationStore> {
  let initial: TransformationSet = { version: 1, transformations: [] };
  try {
    initial = parseTransformationSet(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileTransformationStore(filePath, initial);
}

export function parseTransformationSet(value: unknown): TransformationSet {
  const set = objectValue(value);
  if (set?.version !== 1 || !Array.isArray(set.transformations)) {
    throw new Error("unsupported transformation set");
  }
  for (const transformation of set.transformations) validateTransformation(transformation);
  return structuredClone(set) as unknown as TransformationSet;
}

class FileTransformationStore implements TransformationStore {
  #set: TransformationSet;
  readonly #filePath: string;

  constructor(filePath: string, initial: TransformationSet) {
    this.#filePath = filePath;
    this.#set = initial;
  }

  get(): TransformationSet {
    return structuredClone(this.#set);
  }

  async replace(value: TransformationSet): Promise<void> {
    const set = parseTransformationSet(value);
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
    this.#set = set;
  }
}

function validateTransformation(value: unknown): asserts value is Transformation {
  const transformation = objectValue(value);
  const scope = objectValue(transformation?.scope);
  const target = objectValue(transformation?.target);
  const operation = objectValue(transformation?.operation);
  if (
    typeof transformation?.id !== "string" ||
    typeof transformation.name !== "string" ||
    typeof transformation.enabled !== "boolean" ||
    scope === undefined ||
    target === undefined ||
    operation === undefined ||
    typeof target.field !== "string" ||
    typeof operation.type !== "string"
  ) {
    throw new Error("invalid transformation");
  }
  if (target.field === "json_value" && !validJsonPath(target.jsonPath)) {
    throw new Error("JSON value target requires a non-empty path of string or integer segments");
  }
}

function validJsonPath(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (segment) =>
        typeof segment === "string" ||
        (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

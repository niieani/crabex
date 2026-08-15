import { transformText } from "./text-operation.ts";
import type { JsonPathSegment, TransformationOperation } from "./transformation.ts";

export function transformJsonValue(
  root: Record<string, unknown>,
  path: JsonPathSegment[],
  operation: TransformationOperation,
): number {
  if (path.length === 0) throw new Error("JSON value transformation requires a non-empty path");
  let parent: Record<string, unknown> | unknown[] = root;
  for (const segment of path.slice(0, -1)) {
    const next = jsonChild(parent, segment);
    if (next === undefined || typeof next !== "object" || next === null) return 0;
    parent = next as Record<string, unknown> | unknown[];
  }
  const last = path.at(-1)!;
  const value = jsonChild(parent, last);
  if (value === undefined) return 0;
  if (operation.type === "delete_part") {
    deleteJsonChild(parent, last);
    return 1;
  }
  if (typeof value !== "string") {
    throw new Error(`JSON value at ${JSON.stringify(path)} is not a string`);
  }
  const changed = transformText(value, operation);
  if (changed.matchCount > 0) setJsonChild(parent, last, changed.value);
  return changed.matchCount;
}

function jsonChild(container: Record<string, unknown> | unknown[], segment: JsonPathSegment) {
  if (typeof segment === "number") {
    if (!Number.isSafeInteger(segment) || segment < 0 || !Array.isArray(container))
      return undefined;
    return segment < container.length ? container[segment] : undefined;
  }
  if (Array.isArray(container) || !Object.hasOwn(container, segment)) return undefined;
  return container[segment];
}

function setJsonChild(
  container: Record<string, unknown> | unknown[],
  segment: JsonPathSegment,
  value: string,
): void {
  if (typeof segment === "number") {
    if (!Array.isArray(container) || !Number.isSafeInteger(segment) || segment < 0) {
      throw new Error("numeric JSON path segment requires an array");
    }
    container[segment] = value;
    return;
  }
  if (Array.isArray(container)) throw new Error("string JSON path segment requires an object");
  Object.defineProperty(container, segment, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function deleteJsonChild(
  container: Record<string, unknown> | unknown[],
  segment: JsonPathSegment,
): void {
  if (typeof segment === "number") {
    if (!Array.isArray(container) || !Number.isSafeInteger(segment) || segment < 0) {
      throw new Error("numeric JSON path segment requires an array");
    }
    container.splice(segment, 1);
    return;
  }
  if (Array.isArray(container)) throw new Error("string JSON path segment requires an object");
  delete container[segment];
}

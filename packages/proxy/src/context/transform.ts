import { createHash } from "node:crypto";

import { RE2JS } from "re2js";

import type { HarnessIdentity } from "./harness.ts";
import type {
  Transformation,
  TransformationExecution,
  TransformationOperation,
} from "./transformation.ts";

export interface TransformationContext {
  harness: HarnessIdentity;
  project?: string;
}

export interface ResponseCreatePayload {
  type: string;
  model?: string;
  input?: unknown[];
  [key: string]: unknown;
}

export interface TransformationResult<T extends ResponseCreatePayload> {
  payload: T;
  executions: TransformationExecution[];
}

export function transformResponseCreate<T extends ResponseCreatePayload>(
  payload: T,
  transformations: Transformation[],
  context: TransformationContext,
): TransformationResult<T> {
  if (payload.type !== "response.create") return { payload, executions: [] };
  let transformed = structuredClone(payload);
  const executions: TransformationExecution[] = [];

  for (const transformation of transformations) {
    if (!transformation.enabled || !isInScope(transformation, payload, context)) continue;
    try {
      const result = applyTransformation(structuredClone(transformed), transformation);
      transformed = result.payload;
      executions.push({
        transformationId: transformation.id,
        status: result.matchCount > 0 ? "hit" : "miss",
        matchCount: result.matchCount,
      });
    } catch (error) {
      executions.push({
        transformationId: transformation.id,
        status: "error",
        matchCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { payload: transformed, executions };
}

function applyTransformation<T extends ResponseCreatePayload>(
  payload: T,
  transformation: Transformation,
): { payload: T; matchCount: number } {
  let matchCount = 0;
  const input = Array.isArray(payload.input) ? payload.input : [];

  for (let inputIndex = input.length - 1; inputIndex >= 0; inputIndex -= 1) {
    const item = objectAt(input, inputIndex);
    if (item === undefined) continue;
    const itemPath = `input[${inputIndex}]`;
    if (item.type === "message") {
      matchCount += transformMessage(item, itemPath, transformation);
    } else if (item.type === "additional_tools") {
      matchCount += transformToolContainer(item, itemPath, transformation);
    }
  }

  return { payload, matchCount };
}

function transformMessage(
  message: Record<string, unknown>,
  itemPath: string,
  transformation: Transformation,
): number {
  if (!Array.isArray(message.content)) return 0;
  let count = 0;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = objectAt(message.content, index);
    if (block === undefined || typeof block.text !== "string") continue;
    const path = `${itemPath}.content[${index}].text`;
    if (!matchesTarget(transformation, "message_text", path, block.text)) continue;
    if (transformation.operation.type === "delete_part") {
      message.content.splice(index, 1);
      count += 1;
      continue;
    }
    const changed = transformText(block.text, transformation.operation);
    block.text = changed.value;
    count += changed.matchCount;
  }
  return count;
}

function transformToolContainer(
  container: Record<string, unknown>,
  itemPath: string,
  transformation: Transformation,
): number {
  if (!Array.isArray(container.tools)) return 0;
  return transformTools(container.tools, `${itemPath}.tools`, transformation);
}

function transformTools(
  tools: unknown[],
  parentPath: string,
  transformation: Transformation,
): number {
  let count = 0;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = objectAt(tools, index);
    if (tool === undefined) continue;
    const path = `${parentPath}[${index}]`;
    const serialized = JSON.stringify(tool);
    if (
      transformation.target.field === "tool" &&
      matchesTarget(transformation, "tool", path, serialized, stringValue(tool.name))
    ) {
      if (transformation.operation.type !== "delete_part") {
        throw new Error(`tool transformation ${transformation.id} must delete the whole tool`);
      }
      tools.splice(index, 1);
      count += 1;
      continue;
    }
    if (typeof tool.description === "string") {
      const descriptionPath = `${path}.description`;
      if (
        matchesTarget(
          transformation,
          "tool_description",
          descriptionPath,
          tool.description,
          stringValue(tool.name),
        )
      ) {
        if (transformation.operation.type === "delete_part") {
          delete tool.description;
          count += 1;
        } else {
          const changed = transformText(tool.description, transformation.operation);
          tool.description = changed.value;
          count += changed.matchCount;
        }
      }
    }
    if (transformation.target.field === "all_text") {
      count += transformNestedToolText(
        tool,
        path,
        transformation,
        stringValue(tool.name),
        new Set(["description", "tools"]),
      );
    }
    if (Array.isArray(tool.tools)) {
      count += transformTools(tool.tools, `${path}.tools`, transformation);
    }
  }
  return count;
}

function transformNestedToolText(
  container: Record<string, unknown> | unknown[],
  parentPath: string,
  transformation: Transformation,
  toolName: string | undefined,
  skippedKeys: Set<string> = new Set(),
): number {
  let count = 0;
  const entries = Array.isArray(container)
    ? container.map((value, index) => [String(index), value] as const)
    : Object.entries(container);
  for (const [key, value] of entries.reverse()) {
    if (skippedKeys.has(key)) continue;
    const path = Array.isArray(container) ? `${parentPath}[${key}]` : `${parentPath}.${key}`;
    if (typeof value === "string") {
      if (!matchesTarget(transformation, "tool_description", path, value, toolName)) continue;
      if (transformation.operation.type === "delete_part") {
        if (Array.isArray(container)) container.splice(Number(key), 1);
        else delete container[key];
        count += 1;
      } else {
        const changed = transformText(value, transformation.operation);
        container[key as keyof typeof container] = changed.value as never;
        count += changed.matchCount;
      }
    } else if (typeof value === "object" && value !== null) {
      count += transformNestedToolText(
        value as Record<string, unknown> | unknown[],
        path,
        transformation,
        toolName,
      );
    }
  }
  return count;
}

function matchesTarget(
  transformation: Transformation,
  field: "message_text" | "tool_description" | "tool",
  path: string,
  value: string,
  toolName?: string,
): boolean {
  const target = transformation.target;
  if (target.field !== field && target.field !== "all_text") return false;
  if (target.path !== undefined && target.path !== path) return false;
  if (target.toolName !== undefined && target.toolName !== toolName) return false;
  if (target.variantDigest !== undefined && target.variantDigest !== digest(value)) return false;
  return true;
}

function transformText(
  value: string,
  operation: Exclude<TransformationOperation, { type: "delete_part" }>,
): { value: string; matchCount: number } {
  if (operation.type === "replace") {
    const index = value.indexOf(operation.find);
    if (index === -1) return { value, matchCount: 0 };
    return {
      value:
        value.slice(0, index) + operation.replacement + value.slice(index + operation.find.length),
      matchCount: 1,
    };
  }
  if (operation.type === "replace_all") {
    if (operation.find === "") throw new Error("literal match cannot be empty");
    const matchCount = nonOverlappingCount(value, operation.find);
    return { value: value.replaceAll(operation.find, operation.replacement), matchCount };
  }

  const expression = RE2JS.compile(operation.pattern, re2Flags(operation.flags));
  const matcher = expression.matcher(value);
  let matchCount = 0;
  while (matcher.find()) matchCount += 1;
  if (matchCount === 0) return { value, matchCount };
  const replacementMatcher = expression.matcher(value);
  return {
    value: operation.replaceAll
      ? replacementMatcher.replaceAll(operation.replacement)
      : replacementMatcher.replaceFirst(operation.replacement),
    matchCount: operation.replaceAll ? matchCount : 1,
  };
}

function re2Flags(flags: string): number {
  let result = 0;
  for (const flag of flags) {
    if (flag === "i") result |= RE2JS.CASE_INSENSITIVE;
    else if (flag === "m") result |= RE2JS.MULTILINE;
    else if (flag === "s") result |= RE2JS.DOTALL;
    else throw new Error(`unsupported regular expression flag: ${flag}`);
  }
  return result;
}

function isInScope(
  transformation: Transformation,
  payload: ResponseCreatePayload,
  context: TransformationContext,
): boolean {
  const { scope } = transformation;
  if (scope.harnesses !== undefined && !scope.harnesses.includes(context.harness.kind))
    return false;
  if (scope.models !== undefined && !scope.models.includes(payload.model ?? "")) return false;
  if (scope.projects !== undefined && !scope.projects.includes(context.project ?? "")) return false;
  return true;
}

function nonOverlappingCount(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectAt(values: unknown[], index: number): Record<string, unknown> | undefined {
  const value = values[index];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

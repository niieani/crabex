import { createHash } from "node:crypto";

import { RE2JS } from "re2js";

import { classifyMessage, markdownSections, type ContentSection } from "./classification.ts";
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
      if (Array.isArray(item.content) && item.content.length === 0) input.splice(inputIndex, 1);
    } else if (item.type === "additional_tools") {
      if (transformation.scope.segments !== undefined) continue;
      matchCount += transformToolContainer(item, itemPath, transformation);
    }
  }

  matchCount += transformMetadataTools(payload, transformation);

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
    const classification = classifyMessage(stringValue(message.role), block.text);
    if (!isInSegmentScope(transformation, classification?.id)) continue;
    const identified = transformIdentifiedText(
      block.text,
      transformation,
      classification?.id,
      classification === undefined ? [] : markdownSections(block.text, classification.id),
    );
    if (identified !== undefined) {
      if (identified.deleted) message.content.splice(index, 1);
      else block.text = identified.value;
      count += identified.matchCount;
      continue;
    }
    if (
      !matchesTarget(
        transformation,
        "message_text",
        path,
        block.text,
        undefined,
        classification?.id,
      )
    )
      continue;
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
  namespace?: string,
): number {
  let count = 0;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = objectAt(tools, index);
    if (tool === undefined) continue;
    const path = `${parentPath}[${index}]`;
    const name = stringValue(tool.name);
    const qualifiedName =
      name === undefined ? undefined : namespace === undefined ? name : `${namespace}.${name}`;
    const identifier = qualifiedName === undefined ? undefined : `tool:${qualifiedName}`;
    const serialized = JSON.stringify(tool);
    if (
      transformation.target.field === "tool" &&
      matchesTarget(transformation, "tool", path, serialized, name, identifier)
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
      const identified = transformIdentifiedText(
        tool.description,
        transformation,
        identifier,
        identifier === undefined ? [] : markdownSections(tool.description, identifier),
      );
      if (identified !== undefined) {
        if (identified.deleted) delete tool.description;
        else tool.description = identified.value;
        count += identified.matchCount;
      } else if (
        matchesTarget(
          transformation,
          "tool_description",
          descriptionPath,
          tool.description,
          name,
          identifier,
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
        name,
        new Set(["description", "tools"]),
      );
    }
    if (Array.isArray(tool.tools)) {
      count += transformTools(tool.tools, `${path}.tools`, transformation, qualifiedName);
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
  identifier?: string,
): boolean {
  const target = transformation.target;
  if (target.field !== field && target.field !== "all_text") return false;
  if (target.path !== undefined && target.path !== path) return false;
  if (target.toolName !== undefined && target.toolName !== toolName) return false;
  if (target.identifier !== undefined && target.identifier !== identifier) return false;
  if (target.variantDigest !== undefined && target.variantDigest !== digest(value)) return false;
  return true;
}

function transformIdentifiedText(
  value: string,
  transformation: Transformation,
  partIdentifier: string | undefined,
  sections: ContentSection[],
): { value: string; matchCount: number; deleted: boolean } | undefined {
  const identifier = transformation.target.identifier;
  if (identifier === undefined) return undefined;
  if (identifier === partIdentifier) {
    if (transformation.operation.type === "delete_part") {
      return { value: "", matchCount: 1, deleted: true };
    }
    return { ...transformText(value, transformation.operation), deleted: false };
  }
  const section = findSection(sections, identifier);
  if (section === undefined) return { value, matchCount: 0, deleted: false };
  if (transformation.operation.type === "delete_part") {
    return {
      value: value.slice(0, section.start) + value.slice(section.end),
      matchCount: 1,
      deleted: false,
    };
  }
  const changed = transformText(section.text, transformation.operation);
  return {
    value: value.slice(0, section.start) + changed.value + value.slice(section.end),
    matchCount: changed.matchCount,
    deleted: false,
  };
}

function findSection(sections: ContentSection[], identifier: string): ContentSection | undefined {
  for (const section of sections) {
    if (section.id === identifier) return section;
    const child = findSection(section.children, identifier);
    if (child !== undefined) return child;
  }
  return undefined;
}

function transformMetadataTools(
  payload: ResponseCreatePayload,
  transformation: Transformation,
): number {
  if (transformation.scope.segments !== undefined) return 0;
  if (transformation.operation.type !== "delete_part" || transformation.target.field !== "tool")
    return 0;
  const identifier = transformation.target.identifier;
  const clientMetadata = objectValue(payload.client_metadata);
  const metadataKey = "x-codex-turn-metadata";
  if (clientMetadata === undefined) return 0;
  const encoded = clientMetadata[metadataKey];
  if (typeof encoded !== "string") return 0;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const registry = objectValue(metadata.code_mode_tool_names);
  if (registry === undefined) return 0;
  if (identifier === "registry:code_mode_tool_names") {
    delete metadata.code_mode_tool_names;
    clientMetadata[metadataKey] = JSON.stringify(metadata);
    return 1;
  }
  const name = identifier?.startsWith("tool:") ? identifier.slice("tool:".length) : undefined;
  if (name === undefined) return 0;
  if (!(name in registry)) return 0;
  delete registry[name];
  clientMetadata[metadataKey] = JSON.stringify(metadata);
  return 1;
}

function isInSegmentScope(
  transformation: Transformation,
  segmentIdentifier: string | undefined,
): boolean {
  const segments = transformation.scope.segments;
  return (
    segments === undefined ||
    (segmentIdentifier !== undefined && segments.includes(segmentIdentifier))
  );
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

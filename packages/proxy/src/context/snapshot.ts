import { createHash } from "node:crypto";

import type { CaptureEvent } from "../recording/capture.ts";
import { classifyMessage, markdownSections, type ContentSection } from "./classification.ts";
import type { HarnessIdentity } from "./harness.ts";

export interface ContextSection {
  identifier: string;
  label: string;
  kind: ContentSection["kind"] | "tool_group";
  text: string;
  characters: number;
  estimatedTokens: number;
  children: ContextSection[];
  originalText?: string;
  deleted?: boolean;
}

export interface ContextPart {
  id: string;
  phase: "prewarm" | "inference";
  kind: "message" | "tool";
  role?: string;
  name: string;
  path: string;
  text: string;
  characters: number;
  estimatedTokens: number;
  digest: string;
  identifier?: string;
  description?: string;
  json?: string;
  sections?: ContextSection[];
  originalText?: string;
  originalDescription?: string;
  originalJson?: string;
  deleted?: boolean;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  timestamp: string;
  model: string;
  harness: HarnessIdentity;
  project?: string;
  requestSequences: number[];
  parts: ContextPart[];
  usage?: { inputTokens: number; cachedTokens: number };
}

interface RequestRecord {
  event: CaptureEvent;
  payload: Record<string, unknown>;
  originalPayload: Record<string, unknown>;
  responseId?: string;
  usage?: { inputTokens: number; cachedTokens: number };
}

export function buildSnapshots(events: CaptureEvent[]): ContextSnapshot[] {
  const requests: RequestRecord[] = [];
  const byResponseId = new Map<string, RequestRecord>();
  let pending: RequestRecord | undefined;

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const originalPayload = parseObject(event.payload);
    const payload = parseObject(event.effectivePayload ?? event.payload);
    if (payload?.type === "response.create" && event.direction === "client_to_upstream") {
      pending = { event, payload, originalPayload: originalPayload ?? payload };
      requests.push(pending);
      continue;
    }
    if (payload?.type !== "response.completed" || event.direction !== "upstream_to_client")
      continue;
    const response = objectValue(payload.response);
    const responseId = stringValue(response?.id);
    if (pending === undefined || responseId === undefined) continue;
    pending.responseId = responseId;
    pending.usage = usageValue(response?.usage);
    byResponseId.set(responseId, pending);
    pending = undefined;
  }

  return requests
    .filter((request) => request.payload.generate !== false)
    .map((request) => snapshotFrom(request, byResponseId));
}

function snapshotFrom(
  inference: RequestRecord,
  byResponseId: Map<string, RequestRecord>,
): ContextSnapshot {
  const chain: RequestRecord[] = [];
  let request: RequestRecord | undefined = inference;
  const seen = new Set<RequestRecord>();
  while (request !== undefined && !seen.has(request)) {
    seen.add(request);
    chain.unshift(request);
    const previousResponseId = stringValue(request.payload.previous_response_id);
    request = previousResponseId === undefined ? undefined : byResponseId.get(previousResponseId);
  }
  const parts = aggregateRegistries(chain.flatMap((item) => partsFrom(item)));
  const model = stringValue(inference.payload.model) ?? "unknown";
  return {
    id: `${inference.event.sessionId}:${inference.event.sequence}`,
    sessionId: inference.event.sessionId,
    timestamp: inference.event.timestamp,
    model,
    harness: inference.event.harness ?? { kind: "unknown" },
    ...(inference.event.project === undefined ? {} : { project: inference.event.project }),
    requestSequences: chain.map((item) => item.event.sequence),
    parts,
    ...(inference.usage === undefined ? {} : { usage: inference.usage }),
  };
}

function partsFrom(request: RequestRecord): ContextPart[] {
  const effectiveParts = rawPartsFrom(request, request.payload);
  const originals = rawPartsFrom(request, request.originalPayload);
  const unmatched = new Set(effectiveParts);
  const merged = originals.map((original) => {
    const effective = takeMatchingPart(original, effectiveParts, unmatched);
    if (effective === undefined) return deletedPart(original);
    unmatched.delete(effective);
    return mergePart(effective, original);
  });
  for (const effective of effectiveParts) if (unmatched.has(effective)) merged.push(effective);
  return merged;
}

function takeMatchingPart(
  reference: ContextPart,
  candidates: ContextPart[],
  unmatched: ReadonlySet<ContextPart>,
): ContextPart | undefined {
  const stable = candidates.find(
    (candidate) =>
      unmatched.has(candidate) && stablePartKey(candidate) === stablePartKey(reference),
  );
  if (stable !== undefined) return stable;
  return candidates.find(
    (candidate) =>
      unmatched.has(candidate) &&
      candidate.kind === reference.kind &&
      candidate.role === reference.role &&
      candidate.name === reference.name,
  );
}

function mergePart(effective: ContextPart, original: ContextPart): ContextPart {
  return {
    ...effective,
    path: original.path,
    ...(original.text === effective.text ? {} : { originalText: original.text }),
    ...(original.description === effective.description
      ? {}
      : { originalDescription: original.description }),
    ...(original.json === effective.json ? {} : { originalJson: original.json }),
    sections: mergeSections(effective.sections ?? [], original.sections ?? []),
  };
}

function deletedPart(original: ContextPart): ContextPart {
  return {
    ...original,
    text: "",
    characters: 0,
    estimatedTokens: 0,
    originalText: original.text,
    deleted: true,
  };
}

function stablePartKey(part: ContextPart): string {
  return part.identifier === undefined
    ? `content:${part.kind}:${part.role ?? ""}:${part.digest}`
    : `identifier:${part.identifier}`;
}

function rawPartsFrom(request: RequestRecord, payload: Record<string, unknown>): ContextPart[] {
  const parts: ContextPart[] = [];
  const input = Array.isArray(payload.input) ? payload.input : [];
  const phase = payload.generate === false ? "prewarm" : "inference";
  for (const [inputIndex, inputValue] of input.entries()) {
    const item = objectValue(inputValue);
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const [contentIndex, contentValue] of item.content.entries()) {
        const content = objectValue(contentValue);
        if (typeof content?.text !== "string") continue;
        const path = `input[${inputIndex}].content[${contentIndex}].text`;
        const classification = classifyMessage(stringValue(item.role), content.text);
        parts.push(
          part(request, phase, "message", path, content.text, {
            role: stringValue(item.role),
            name: classification?.label ?? `${stringValue(item.role) ?? "message"} message`,
            identifier: classification?.id,
            sections:
              classification === undefined
                ? undefined
                : sectionsValue(markdownSections(content.text, classification.id)),
          }),
        );
      }
    } else if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
      collectTools(request, phase, item.tools, `input[${inputIndex}].tools`, parts);
    }
  }
  collectMetadataTools(request, phase, payload, parts);
  return parts;
}

function collectTools(
  request: RequestRecord,
  phase: "prewarm" | "inference",
  tools: unknown[],
  parentPath: string,
  parts: ContextPart[],
  namespace?: string,
): void {
  for (const [index, toolValue] of tools.entries()) {
    const tool = objectValue(toolValue);
    if (tool === undefined) continue;
    const name = stringValue(tool.name) ?? `tool-${index}`;
    const qualifiedName = namespace === undefined ? name : `${namespace}.${name}`;
    const path = `${parentPath}[${index}]`;
    if (Array.isArray(tool.tools)) {
      collectTools(request, phase, tool.tools, `${path}.tools`, parts, qualifiedName);
    } else {
      const identifier = `tool:${qualifiedName}`;
      const description = stringValue(tool.description);
      parts.push(
        part(request, phase, "tool", path, JSON.stringify(tool, null, 2), {
          name: qualifiedName,
          identifier,
          description,
          json: JSON.stringify(abbreviatedTool(tool), null, 2),
          sections:
            description === undefined
              ? undefined
              : sectionsValue(markdownSections(description, identifier)),
        }),
      );
    }
  }
}

function collectMetadataTools(
  request: RequestRecord,
  phase: "prewarm" | "inference",
  payload: Record<string, unknown>,
  parts: ContextPart[],
): void {
  const clientMetadata = objectValue(payload.client_metadata);
  const encoded = stringValue(clientMetadata?.["x-codex-turn-metadata"]);
  if (encoded === undefined) return;
  const metadata = parseObject(encoded);
  const registry = objectValue(metadata?.code_mode_tool_names);
  if (registry === undefined) return;
  const text = JSON.stringify(registry, null, 2);
  parts.push(
    part(
      request,
      phase,
      "tool",
      "client_metadata.x-codex-turn-metadata.code_mode_tool_names",
      text,
      {
        name: "Code mode tools",
        identifier: "registry:code_mode_tool_names",
        json: text,
        sections: registrySections(registry),
      },
    ),
  );
}

function part(
  request: RequestRecord,
  phase: "prewarm" | "inference",
  kind: "message" | "tool",
  path: string,
  text: string,
  metadata: {
    role?: string;
    name: string;
    identifier?: string;
    description?: string;
    json?: string;
    sections?: ContextSection[];
  },
): ContextPart {
  const digest = sha256(text);
  return {
    id: `${request.event.sequence}:${path}:${digest.slice(0, 12)}`,
    phase,
    kind,
    ...(metadata.role === undefined ? {} : { role: metadata.role }),
    name: metadata.name,
    ...(metadata.identifier === undefined ? {} : { identifier: metadata.identifier }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.json === undefined ? {} : { json: metadata.json }),
    ...(metadata.sections === undefined || metadata.sections.length === 0
      ? {}
      : { sections: metadata.sections }),
    path,
    text,
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    digest,
  };
}

function sectionsValue(sections: ContentSection[]): ContextSection[] {
  return sections.map((section) => ({
    identifier: section.id,
    label: section.label,
    kind: section.kind,
    text: section.text,
    characters: section.text.length,
    estimatedTokens: Math.ceil(section.text.length / 4),
    children: sectionsValue(section.children),
  }));
}

function mergeSections(effective: ContextSection[], original: ContextSection[]): ContextSection[] {
  const unmatched = new Map(effective.map((section) => [section.identifier, section]));
  const merged = original.map((previous) => {
    const section = unmatched.get(previous.identifier);
    unmatched.delete(previous.identifier);
    if (section === undefined) return deletedSection(previous);
    return {
      ...section,
      ...(previous.text === section.text ? {} : { originalText: previous.text }),
      children: mergeSections(section.children, previous.children),
    };
  });
  for (const section of unmatched.values()) merged.push(section);
  return merged;
}

function deletedSection(section: ContextSection): ContextSection {
  return {
    ...section,
    text: "",
    characters: 0,
    estimatedTokens: 0,
    originalText: section.text,
    deleted: true,
    children: section.children.map(deletedSection),
  };
}

function registrySections(registry: Record<string, unknown>): ContextSection[] {
  const roots: ContextSection[] = [];
  for (const [name, value] of Object.entries(registry).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const segments = name.split("__");
    const label = segments.pop() ?? name;
    let children = roots;
    const prefix: string[] = [];
    for (const segment of segments) {
      prefix.push(segment);
      const identifier = `registry-group:${prefix.join("__")}`;
      let group = children.find((section) => section.identifier === identifier);
      if (group === undefined) {
        group = sectionValue(identifier, segment, "tool_group", "");
        children.push(group);
      }
      children = group.children;
    }
    children.push(
      sectionValue(
        `tool:${name}`,
        label,
        name.startsWith("mcp__") ? "mcp" : "tool",
        JSON.stringify(value, null, 2),
      ),
    );
  }
  updateGroupSizes(roots);
  return roots;
}

function sectionValue(
  identifier: string,
  label: string,
  kind: ContextSection["kind"],
  text: string,
): ContextSection {
  return {
    identifier,
    label,
    kind,
    text,
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    children: [],
  };
}

function updateGroupSizes(sections: ContextSection[]): void {
  for (const section of sections) {
    updateGroupSizes(section.children);
    if (section.kind !== "tool_group") continue;
    section.characters = section.children.reduce((total, child) => total + child.characters, 0);
    section.estimatedTokens = section.children.reduce(
      (total, child) => total + child.estimatedTokens,
      0,
    );
  }
}

function aggregateRegistries(parts: ContextPart[]): ContextPart[] {
  const registries = parts.filter((part) => part.identifier === "registry:code_mode_tool_names");
  if (registries.length <= 1) return parts;
  const effective: Record<string, unknown> = {};
  const original: Record<string, unknown> = {};
  for (const registry of registries) {
    Object.assign(effective, parseObject(registry.text) ?? {});
    Object.assign(original, parseObject(registry.originalText ?? registry.text) ?? {});
  }
  const text = JSON.stringify(effective, null, 2);
  const originalText = JSON.stringify(original, null, 2);
  const base = registries.at(-1)!;
  const digest = sha256(text);
  const aggregate: ContextPart = {
    ...base,
    id: `registry:code_mode_tool_names:${digest.slice(0, 12)}`,
    phase: registries.some((part) => part.phase === "inference") ? "inference" : "prewarm",
    text,
    json: text,
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    digest,
    sections: mergeSections(registrySections(effective), registrySections(original)),
    ...(text === originalText ? {} : { originalText, originalJson: originalText }),
  };
  return [
    ...parts.filter((part) => part.identifier !== "registry:code_mode_tool_names"),
    aggregate,
  ];
}

function abbreviatedTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (typeof tool.description !== "string") return tool;
  const [firstLine = ""] = tool.description.split("\n", 1);
  return {
    ...tool,
    description: tool.description.includes("\n") ? `${firstLine}…` : firstLine,
  };
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usageValue(value: unknown): { inputTokens: number; cachedTokens: number } | undefined {
  const usage = objectValue(value);
  if (typeof usage?.input_tokens !== "number") return undefined;
  const details = objectValue(usage.input_tokens_details);
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : 0,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

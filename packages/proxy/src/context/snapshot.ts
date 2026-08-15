import { createHash } from "node:crypto";

import type { CaptureEvent } from "../recording/capture.ts";
import type { HarnessIdentity } from "./harness.ts";

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
  responseId?: string;
  usage?: { inputTokens: number; cachedTokens: number };
}

export function buildSnapshots(events: CaptureEvent[]): ContextSnapshot[] {
  const requests: RequestRecord[] = [];
  const byResponseId = new Map<string, RequestRecord>();
  let pending: RequestRecord | undefined;

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = parseObject(event.effectivePayload ?? event.payload);
    if (payload?.type === "response.create" && event.direction === "client_to_upstream") {
      pending = { event, payload };
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
  const parts = chain.flatMap((item) => partsFrom(item));
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
  const parts: ContextPart[] = [];
  const input = Array.isArray(request.payload.input) ? request.payload.input : [];
  const phase = request.payload.generate === false ? "prewarm" : "inference";
  for (const [inputIndex, inputValue] of input.entries()) {
    const item = objectValue(inputValue);
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const [contentIndex, contentValue] of item.content.entries()) {
        const content = objectValue(contentValue);
        if (typeof content?.text !== "string") continue;
        const path = `input[${inputIndex}].content[${contentIndex}].text`;
        parts.push(
          part(request, phase, "message", path, content.text, {
            role: stringValue(item.role),
            name: `${stringValue(item.role) ?? "message"} message`,
          }),
        );
      }
    } else if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
      collectTools(request, phase, item.tools, `input[${inputIndex}].tools`, parts);
    }
  }
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
      parts.push(
        part(request, phase, "tool", path, JSON.stringify(tool, null, 2), { name: qualifiedName }),
      );
    }
  }
}

function part(
  request: RequestRecord,
  phase: "prewarm" | "inference",
  kind: "message" | "tool",
  path: string,
  text: string,
  metadata: { role?: string; name: string },
): ContextPart {
  const digest = sha256(text);
  return {
    id: `${request.event.sequence}:${path}:${digest.slice(0, 12)}`,
    phase,
    kind,
    ...(metadata.role === undefined ? {} : { role: metadata.role }),
    name: metadata.name,
    path,
    text,
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    digest,
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

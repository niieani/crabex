import { ToolPolicyError } from "../routing/tool-policy.ts";

type JsonObject = Record<string, unknown>;
type Entry = { declarations: JsonObject[]; expiresAt: number };

const MAX_SESSIONS = 512;
const MAX_TOOLS = 256;
const MAX_DECLARATION_BYTES = 1024 * 1024;
const STATE_TTL_MS = 30 * 60_000;
const MAX_RESULT_TEXT = 12_000;

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Loaded client tools for one account, thread, and model route. */
export class LoadedToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Reconcile full history or merge a stored delta, then inject live declarations. */
  prepare(
    routeSlug: string,
    key: string | undefined,
    fullPayload: JsonObject,
    outboundPayload: JsonObject,
  ): JsonObject {
    const deltaOnly =
      typeof outboundPayload.previous_response_id === "string" &&
      outboundPayload.previous_response_id.length > 0;
    const input = Array.isArray(fullPayload.input) ? fullPayload.input : [];
    const lastCompaction = input.findLastIndex(
      (item) =>
        record(item) &&
        ["compaction", "compaction_summary", "context_compaction"].includes(String(item.type)),
    );
    const visibleHistory = input.slice(lastCompaction + 1);
    const outputs = visibleHistory.filter(
      (item): item is JsonObject => record(item) && item.type === "tool_search_output",
    );
    const prior = key === undefined ? undefined : this.get(key);
    if (deltaOnly && prior === undefined && outputs.length === 0) {
      throw new ToolPolicyError(
        `model route "${routeSlug}" lost loaded tools for a delta-only continuation; replay full history or start a new turn`,
      );
    }

    // A full replay is authoritative. An explicit compaction item is a boundary;
    // local compaction is detected when its replacement full replay has no outputs.
    let declarations = !deltaOnly || lastCompaction >= 0 ? [] : (prior?.declarations ?? []);
    for (const output of outputs) {
      if (!Array.isArray(output.tools)) {
        throw new ToolPolicyError(
          `model route "${routeSlug}" received invalid tool_search_output.tools`,
        );
      }
      declarations = mergeDeclarations(
        declarations,
        output.tools.map((tool) => normalizeDiscovered(tool, routeSlug)),
        true,
      );
    }
    if (
      countTools(declarations) > MAX_TOOLS ||
      Buffer.byteLength(JSON.stringify(declarations)) > MAX_DECLARATION_BYTES
    ) {
      throw new ToolPolicyError(`model route "${routeSlug}" exceeded the loaded-tool limit`);
    }
    if (key !== undefined) this.set(key, declarations);

    const tools = mergeDeclarations(
      Array.isArray(outboundPayload.tools) ? outboundPayload.tools.filter(record) : [],
      declarations,
      false,
    );
    return { ...outboundPayload, tools };
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private set(key: string, declarations: JsonObject[]): void {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      declarations: structuredClone(declarations),
      expiresAt: now + STATE_TTL_MS,
    });
    for (const [candidate, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(candidate);
    }
    while (this.entries.size > MAX_SESSIONS) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Brief result text; the complete discovered schemas are injected as declarations. */
export function toolSearchResultText(item: JsonObject): string {
  if (item.status !== "completed")
    return `Tool discovery ${typeof item.status === "string" ? item.status : "failed"}.`;
  const names: string[] = [];
  const tools = Array.isArray(item.tools) ? item.tools : [];
  for (const tool of tools) {
    if (!record(tool)) continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (record(child) && typeof child.name === "string") {
          names.push(describeTool(`${String(tool.name)}.${child.name}`, child));
        }
      }
    } else if (typeof tool.name === "string") {
      names.push(describeTool(tool.name, tool));
    }
  }
  const result = names.length
    ? `Discovered tools now available in the tools list:\n${names.map((name) => `- ${name}`).join("\n")}`
    : "No matching tools were found.";
  return result.slice(0, MAX_RESULT_TEXT);
}

function describeTool(name: string, tool: JsonObject): string {
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  return description ? `${name}: ${description.slice(0, 240)}` : name;
}

function normalizeDiscovered(value: unknown, routeSlug: string): JsonObject {
  if (!record(value)) throw invalidDiscovered(routeSlug);
  const { defer_loading: _deferred, ...rest } = value;
  if (value.type === "namespace") {
    if (typeof value.name !== "string" || !Array.isArray(value.tools))
      throw invalidDiscovered(routeSlug);
    return {
      ...rest,
      tools: value.tools.map((child) => normalizeDiscovered(child, routeSlug)),
    };
  }
  if (value.type !== "function" || typeof value.name !== "string")
    throw invalidDiscovered(routeSlug);
  return rest;
}

function invalidDiscovered(routeSlug: string): ToolPolicyError {
  return new ToolPolicyError(`model route "${routeSlug}" received invalid discovered tool`);
}

function mergeDeclarations(
  base: JsonObject[],
  additions: JsonObject[],
  replace: boolean,
): JsonObject[] {
  const merged = structuredClone(base);
  for (const addition of additions) {
    if (addition.type === "namespace" && Array.isArray(addition.tools)) {
      const existing = merged.find(
        (tool) => tool.type === "namespace" && tool.name === addition.name,
      );
      if (existing === undefined) {
        merged.push(structuredClone(addition));
        continue;
      }
      const children = Array.isArray(existing.tools) ? (existing.tools as JsonObject[]) : [];
      for (const child of addition.tools) {
        if (record(child)) upsert(children, child, replace);
      }
      existing.tools = children;
    } else {
      upsert(merged, addition, replace);
    }
  }
  return merged;
}

function upsert(tools: JsonObject[], tool: JsonObject, replace: boolean): void {
  const index = tools.findIndex(
    (existing) =>
      (existing.type === "function" || existing.type === "custom") && existing.name === tool.name,
  );
  if (index < 0) tools.push(structuredClone(tool));
  else if (replace) tools[index] = structuredClone(tool);
}

function countTools(declarations: JsonObject[]): number {
  return declarations.reduce(
    (count, tool) =>
      count + (tool.type === "namespace" && Array.isArray(tool.tools) ? tool.tools.length : 1),
    0,
  );
}

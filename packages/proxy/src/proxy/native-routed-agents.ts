import { createHash } from "node:crypto";
import { PersistentLruCache } from "../config/persistent-lru-cache.ts";
import { parseSseEvents, wrappedErrorEvent } from "./responses-bridge.ts";

type JsonObject = Record<string, unknown>;
type PendingSpawn = { taskName: string; model: string };
type AgentScope = { pending: Record<string, PendingSpawn>; targets: Record<string, string> };

const NAMES = new Set(["spawn_agent", "send_message", "followup_task"]);
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class RoutedAgentsError extends Error {}

function agentScope(value: unknown): value is AgentScope {
  if (!record(value) || !record(value.pending) || !record(value.targets)) return false;
  return (
    Object.values(value.pending).every(
      (item) => record(item) && typeof item.taskName === "string" && typeof item.model === "string",
    ) && Object.values(value.targets).every((item) => typeof item === "string")
  );
}

/** Parent-thread child targets; the persistent cache hashes account/thread scope keys. */
export class RoutedAgentRegistry {
  private readonly entries: PersistentLruCache<AgentScope>;

  constructor(entries = new PersistentLruCache<AgentScope>(cacheOptions())) {
    this.entries = entries;
  }

  static async open(path: string): Promise<RoutedAgentRegistry> {
    return new RoutedAgentRegistry(await PersistentLruCache.open(path, cacheOptions()));
  }

  rememberSpawn(scope: string, callId: string, taskName: string, model: string): void {
    const value = this.entries.get(scope) ?? { pending: {}, targets: {} };
    value.pending[callId] = { taskName, model };
    trim(value.pending);
    this.entries.set(scope, value);
  }

  observeSpawnOutput(scope: string, callId: string, output: unknown): void {
    const value = this.entries.get(scope);
    const pending = value?.pending[callId];
    if (value === undefined || pending === undefined) return;
    const parsed = parseOutput(output);
    if (!record(parsed) || typeof parsed.task_name !== "string" || !parsed.task_name) return;
    value.targets[parsed.task_name] = pending.model;
    delete value.pending[callId];
    trim(value.targets);
    this.entries.set(scope, value);
  }

  targetModel(scope: string, target: string): string | undefined {
    const value = this.entries.get(scope);
    if (value === undefined) return undefined;
    if (value.targets[target]) return value.targets[target];
    return Object.entries(value.targets).find(([path]) => path.endsWith(`/${target}`))?.[1];
  }

  flush(): Promise<void> {
    return this.entries.flush();
  }
}

function cacheOptions() {
  return {
    ttlMs: TTL_MS,
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    isValue: agentScope,
  };
}

function trim(value: Record<string, unknown>): void {
  while (Object.keys(value).length > 128) delete value[Object.keys(value)[0]!];
}

function parseOutput(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(output)) {
    const text = output.find(
      (part) => record(part) && part.type === "text" && typeof part.text === "string",
    );
    return record(text) ? parseOutput(text.text) : undefined;
  }
  return output;
}

function variantTools(tools: unknown[], models: string[]): JsonObject[] | undefined {
  if (
    tools.some((tool) => record(tool) && tool.type === "namespace" && tool.name === "routed_agents")
  )
    return undefined;
  const collaboration = tools.find(
    (tool) => record(tool) && tool.type === "namespace" && tool.name === "collaboration",
  );
  if (!record(collaboration) || !Array.isArray(collaboration.tools)) return undefined;
  const members = collaboration.tools.filter(
    (member) => record(member) && NAMES.has(String(member.name)),
  );
  if (members.length !== NAMES.size) return undefined;
  if (
    members.some(
      (member) =>
        !record(member) ||
        !record(member.parameters) ||
        !record(member.parameters.properties) ||
        !record(member.parameters.properties.message) ||
        member.parameters.properties.message.encrypted !== true,
    )
  )
    return undefined;
  const copies = structuredClone(members) as JsonObject[];
  for (const member of copies) {
    const parameters = member.parameters as JsonObject;
    const properties = parameters.properties as JsonObject;
    const message = properties.message as JsonObject;
    delete message.encrypted;
    message.description = "Plaintext message for a routed custom-model agent.";
    if (member.name === "spawn_agent") {
      const model = properties.model;
      if (!record(model)) return undefined;
      model.enum = models;
      model.description = "Required routed custom-model slug.";
      parameters.required = [
        ...new Set([...(Array.isArray(parameters.required) ? parameters.required : []), "model"]),
      ];
      member.description =
        "Spawn a routed custom-model child. Use collaboration.spawn_agent for a native OpenAI child.";
    } else {
      member.description = `Send plaintext to a routed custom-model child. Use collaboration.${String(member.name)} for a native OpenAI child.`;
    }
  }
  return [
    ...tools,
    {
      type: "namespace",
      name: "routed_agents",
      description:
        "Plaintext agent tools for routed custom-model children only. Use collaboration for native OpenAI children.",
      tools: copies,
    },
  ] as JsonObject[];
}

function revisedAdditionalToolsId(id: unknown, tools: unknown[]): string {
  const bytes = createHash("sha1")
    .update(typeof id === "string" ? id : "")
    .update(JSON.stringify(tools))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `at_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Native ChatGPT wire adapter for an additive non-reserved plaintext namespace. */
export class NativeRoutedAgentsBridge {
  private readonly models: string[];
  private readonly scope: string;
  private readonly registry: RoutedAgentRegistry;

  constructor(models: string[], scope: string, registry: RoutedAgentRegistry) {
    this.models = [...new Set(models)].sort();
    this.scope = scope;
    this.registry = registry;
  }

  request(payload: JsonObject): JsonObject {
    if (this.models.length === 0) return payload;
    let changed = false;
    let tools = payload.tools;
    if (Array.isArray(tools)) {
      const variant = variantTools(tools, this.models);
      if (variant !== undefined) {
        tools = variant;
        changed = true;
      }
    }
    let input = payload.input;
    if (Array.isArray(input)) {
      input = input.map((raw) => {
        if (!record(raw)) return raw;
        if (raw.type === "additional_tools" && Array.isArray(raw.tools)) {
          const variant = variantTools(raw.tools, this.models);
          if (variant !== undefined) {
            changed = true;
            return {
              ...raw,
              tools: variant,
              id: revisedAdditionalToolsId(raw.id, variant),
            };
          }
        }
        if (
          raw.type === "function_call" &&
          raw.namespace === "collaboration" &&
          NAMES.has(String(raw.name)) &&
          Array.isArray(raw.encrypted_function_args) &&
          raw.encrypted_function_args.length === 0
        ) {
          const mapped: JsonObject = { ...raw, namespace: "routed_agents" };
          delete mapped.encrypted_function_args;
          this.observeCall(mapped);
          changed = true;
          return mapped;
        }
        if (raw.type === "function_call_output" && typeof raw.call_id === "string")
          this.registry.observeSpawnOutput(this.scope, raw.call_id, raw.output);
        return raw;
      });
    }
    return changed ? { ...payload, tools, input } : payload;
  }

  event(data: string): string {
    if (this.models.length === 0) return data;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return data;
    }
    if (!record(value)) return data;
    if (
      (value.type === "response.output_item.added" || value.type === "response.output_item.done") &&
      record(value.item)
    ) {
      const mapped = this.codexItem(value.item, value.type === "response.output_item.done");
      return mapped === value.item ? data : JSON.stringify({ ...value, item: mapped });
    }
    if (value.type === "response.completed" && record(value.response)) {
      const mapped = this.response(value.response);
      return mapped === value.response ? data : JSON.stringify({ ...value, response: mapped });
    }
    return data;
  }

  response(value: unknown): unknown {
    if (!record(value) || !Array.isArray(value.output) || this.models.length === 0) return value;
    const originalOutput = value.output;
    const output = originalOutput.map((item) => (record(item) ? this.codexItem(item, true) : item));
    return output.some((item, index) => item !== originalOutput[index])
      ? { ...value, output }
      : value;
  }

  private codexItem(item: JsonObject, complete: boolean): JsonObject {
    if (
      item.type !== "function_call" ||
      item.namespace !== "routed_agents" ||
      !NAMES.has(String(item.name))
    )
      return item;
    if (complete) this.observeCall(item);
    return { ...item, namespace: "collaboration", encrypted_function_args: [] };
  }

  private observeCall(item: JsonObject): void {
    let args: unknown;
    try {
      args = JSON.parse(String(item.arguments));
    } catch {
      throw new RoutedAgentsError(`routed_agents.${String(item.name)} has invalid arguments`);
    }
    if (!record(args) || typeof args.message !== "string")
      throw new RoutedAgentsError(
        `routed_agents.${String(item.name)} requires a plaintext message`,
      );
    if (item.name === "spawn_agent") {
      if (typeof args.model !== "string" || !this.models.includes(args.model))
        throw new RoutedAgentsError(`routed_agents.spawn_agent requires a configured routed model`);
      if (typeof args.task_name !== "string" || !args.task_name)
        throw new RoutedAgentsError(`routed_agents.spawn_agent requires task_name`);
      if (typeof item.call_id === "string")
        this.registry.rememberSpawn(this.scope, item.call_id, args.task_name, args.model);
    } else {
      if (typeof args.target !== "string" || !this.registry.targetModel(this.scope, args.target))
        throw new RoutedAgentsError(
          `routed_agents.${String(item.name)} target "${String(args.target)}" is not a known routed child`,
        );
    }
  }
}

export function translateNativeRoutedAgentsStream(
  body: ReadableStream<Uint8Array>,
  bridge: NativeRoutedAgentsBridge,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = (async function* () {
    for await (const event of parseSseEvents(body)) {
      try {
        yield encoder.encode(`data: ${bridge.event(event)}\n\n`);
      } catch (error) {
        if (!(error instanceof RoutedAgentsError)) throw error;
        yield encoder.encode(`data: ${wrappedErrorEvent(422, error.message)}\n\n`);
        return;
      }
    }
  })();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

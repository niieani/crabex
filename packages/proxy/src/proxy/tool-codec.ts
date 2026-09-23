// Custom-tool wrapping is informed by opencodex (MIT); see THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export interface ToolTransforms {
  namespace: "flatten" | "preserve";
  custom: "wrap" | "preserve";
  union: "wrap" | "preserve";
  other?: "pass" | "reject";
}

export interface MappedTool {
  name: string;
  namespace?: string;
  wire: string;
  wireNamespace?: string;
  custom: boolean;
  wrapped: boolean;
  description: unknown;
  parameters: JsonObject;
}

export interface WireToolCall {
  name: string;
  namespace?: string;
  callId: string;
  input?: unknown;
}

export interface ToolCodec {
  readonly tools: MappedTool[];
  /** Responses declarations after the selected transforms. */
  readonly declarations: JsonObject[];
  resolve(item: JsonObject): MappedTool;
  byWire(name: unknown, namespace?: unknown): MappedTool | undefined;
  encode(item: JsonObject): WireToolCall;
  /** Omit input for a stream's added item; decode assembled input when the call completes. */
  decode(call: WireToolCall): JsonObject;
}

export class ToolCodecError extends Error {
  readonly code?: "unsupported" | "ambiguous";
  constructor(message: string, code?: "unsupported" | "ambiguous") {
    super(message);
    this.code = code;
  }
}

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 48);

export function normalizeToolCallId(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new ToolCodecError("Tool call is missing its call_id");
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : `call_${hash(value)}`;
}

function wireName(name: string, namespace: string | undefined, transforms: ToolTransforms): string {
  if (transforms.namespace === "preserve") return name;
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  return `tool_${hash(JSON.stringify([namespace, name]))}`;
}

function customSchema(name: string): JsonObject {
  return {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          name === "apply_patch"
            ? "Raw patch starting with *** Begin Patch and ending with *** End Patch."
            : "Raw tool input, without markdown fences.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  };
}

function wrapUnion(schema: JsonObject): JsonObject {
  const relocated: JsonObject = JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))
        ? "#/properties/arguments" + value.slice(1)
        : value,
    ),
  );
  return {
    type: "object",
    properties: { arguments: relocated },
    required: ["arguments"],
    additionalProperties: false,
  };
}

/** One request-local identity map; later declarations can be merged before construction. */
export function createToolCodec(input: unknown, transforms: ToolTransforms): ToolCodec {
  const tools: MappedTool[] = [];
  const declarations: JsonObject[] = [];

  function add(value: unknown, namespace?: string): JsonObject[] {
    if (!record(value)) throw new ToolCodecError("Invalid tool definition");
    if (value.type === "namespace" && Array.isArray(value.tools)) {
      const childNamespace =
        transforms.namespace === "flatten" && value.name === "functions"
          ? undefined
          : String(value.name);
      const children = value.tools.flatMap((child) => add(child, childNamespace));
      return transforms.namespace === "flatten" ? children : [{ ...value, tools: children }];
    }
    if (value.type !== "function" && value.type !== "custom") {
      if (transforms.other === "pass") return [value];
      throw new ToolCodecError(`Unsupported tool type: ${String(value.type)}`, "unsupported");
    }
    if (typeof value.name !== "string") throw new ToolCodecError("Tool definition requires a name");
    const custom = value.type === "custom";
    const parameters = custom
      ? transforms.custom === "wrap"
        ? customSchema(value.name)
        : {}
      : value.parameters;
    if (!record(parameters))
      throw new ToolCodecError(`Tool ${value.name} requires an object schema`);
    const wrapped =
      !custom &&
      transforms.union === "wrap" &&
      ["oneOf", "anyOf", "allOf"].some((key) => key in parameters);
    const wire = wireName(value.name, namespace, transforms);
    const wireNamespace = transforms.namespace === "preserve" ? namespace : undefined;
    const wireParameters = wrapped ? wrapUnion(parameters) : parameters;
    tools.push({
      name: value.name,
      namespace,
      wire,
      ...(wireNamespace !== undefined ? { wireNamespace } : {}),
      custom,
      wrapped,
      description: value.description ?? "",
      parameters: wireParameters,
    });
    if (custom && transforms.custom === "preserve") return [{ ...value, name: wire }];
    if (custom)
      return [
        {
          type: "function",
          name: wire,
          description: value.description ?? "",
          parameters: wireParameters,
        },
      ];
    return [
      {
        ...value,
        type: "function",
        name: wire,
        parameters: wireParameters,
      },
    ];
  }

  if (Array.isArray(input)) for (const value of input) declarations.push(...add(value));
  const wireKeys = tools.map((tool) => JSON.stringify([tool.wireNamespace, tool.wire]));
  if (new Set(wireKeys).size !== wireKeys.length)
    throw new ToolCodecError("Ambiguous tool names", "ambiguous");

  function resolve(item: JsonObject): MappedTool {
    const requestedNamespace =
      transforms.namespace === "flatten" && item.namespace === "functions"
        ? undefined
        : item.namespace;
    const namespace = typeof requestedNamespace === "string" ? requestedNamespace : undefined;
    return (
      tools.find((tool) => tool.name === item.name && tool.namespace === requestedNamespace) ?? {
        name: String(item.name),
        namespace,
        wire: wireName(String(item.name), namespace, transforms),
        ...(transforms.namespace === "preserve" && namespace !== undefined
          ? { wireNamespace: namespace }
          : {}),
        custom: item.type === "custom_tool_call" || item.type === "custom",
        wrapped: false,
        description: "",
        parameters: {},
      }
    );
  }

  function byWire(name: unknown, namespace?: unknown): MappedTool | undefined {
    return tools.find((tool) => tool.wire === name && tool.wireNamespace === namespace);
  }

  function encode(item: JsonObject): WireToolCall {
    const tool = resolve(item);
    let args: unknown;
    try {
      if (tool.custom) args = transforms.custom === "wrap" ? { input: item.input } : item.input;
      else {
        if (item.arguments != null && typeof item.arguments !== "string")
          throw new Error("Expected a string field");
        args = JSON.parse(item.arguments ?? "{}");
      }
    } catch (error) {
      if (error instanceof ToolCodecError) throw error;
      throw new ToolCodecError(`Invalid JSON arguments for ${tool.name}`);
    }
    if (!tool.custom || transforms.custom === "wrap") {
      if (!record(args))
        throw new ToolCodecError(`Tool arguments for ${tool.name} must be an object`);
    } else if (typeof args !== "string") {
      throw new ToolCodecError("Custom tool requires a string input");
    }
    return {
      name: tool.wire,
      ...(tool.wireNamespace !== undefined ? { namespace: tool.wireNamespace } : {}),
      callId: normalizeToolCallId(item.call_id),
      input: tool.wrapped ? { arguments: args } : args,
    };
  }

  function decode(call: WireToolCall): JsonObject {
    const tool = byWire(call.name, call.namespace);
    if (!tool) throw new ToolCodecError(`Unknown wire tool: ${String(call.name)}`);
    const item: JsonObject = {
      type: tool.custom ? "custom_tool_call" : "function_call",
      call_id: call.callId,
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      ...(tool.custom ? { input: "" } : { arguments: "" }),
    };
    if (call.input === undefined) return item;
    if (tool.custom) {
      const input =
        transforms.custom === "wrap"
          ? record(call.input)
            ? call.input.input
            : undefined
          : call.input;
      if (typeof input !== "string")
        throw new ToolCodecError("Custom tool requires a string input");
      item.input = input;
    } else {
      if (!record(call.input)) throw new ToolCodecError("Tool arguments are not a JSON object");
      const args = tool.wrapped ? call.input.arguments : call.input;
      if (!record(args)) throw new ToolCodecError("Wrapped tool requires an arguments object");
      item.arguments = JSON.stringify(args);
    }
    return item;
  }

  return { tools, declarations, resolve, byWire, encode, decode };
}

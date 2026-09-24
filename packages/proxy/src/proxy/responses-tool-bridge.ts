import type { ModelRoute } from "../routing/model-routes.ts";
import { ToolPolicyError } from "../routing/tool-policy.ts";
import { createToolCodec, type MappedTool, type ToolCodec } from "./tool-codec.ts";
import { toolSearchResultText } from "./tool-search.ts";
import { parseSseEvents } from "./responses-bridge.ts";

type JsonObject = Record<string, unknown>;
type CallState = {
  tool: MappedTool;
  callId: string;
  arguments: string;
  inputEmitted: boolean;
};

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Request-local translation for an HTTP Responses upstream. */
export class ResponsesToolBridge {
  private readonly codec: ToolCodec;
  private readonly routeSlug: string;
  private readonly callsById = new Map<string, CallState>();
  private readonly callsByIndex = new Map<number, CallState>();
  private sequence = 0;
  private readonly modes: { custom: boolean; search: boolean };

  constructor(
    routeSlug: string,
    declarations: unknown,
    modes: { custom: boolean; search: boolean },
  ) {
    this.routeSlug = routeSlug;
    this.modes = modes;
    try {
      this.codec = createToolCodec(declarations, {
        namespace: "preserve",
        custom: modes.custom ? "wrap" : "preserve",
        toolSearch: modes.search ? "function" : "pass",
        union: "preserve",
        functionSchema: "preserve",
        callId: "preserve",
        other: "pass",
        plaintextCollaboration: modes.custom,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  request(payload: JsonObject): JsonObject {
    return this.guard(() => {
      const translated: JsonObject = { ...payload };
      if (Array.isArray(payload.tools)) translated.tools = this.codec.declarations;
      if (Array.isArray(payload.input)) {
        translated.input = payload.input.map((item) => {
          if (!record(item)) return item;
          if (
            (item.type === "custom_tool_call" && this.modes.custom) ||
            (item.type === "tool_search_call" && this.modes.search)
          ) {
            const call = this.codec.encode(item);
            const { input: _input, execution: _execution, ...rest } = item;
            return {
              ...rest,
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
              arguments: JSON.stringify(call.input),
            };
          }
          if (item.type === "custom_tool_call_output" && this.modes.custom) {
            if (typeof item.call_id !== "string" || !item.call_id)
              throw new Error("Tool call is missing its call_id");
            return {
              ...item,
              type: "function_call_output",
              call_id: item.call_id,
            };
          }
          if (item.type === "tool_search_output" && this.modes.search) {
            if (typeof item.call_id !== "string" || !item.call_id)
              throw new Error("Tool search output is missing its call_id");
            return {
              type: "function_call_output",
              call_id: item.call_id,
              output: toolSearchResultText(item),
            };
          }
          return item;
        });
      }
      if (
        record(payload.tool_choice) &&
        ((payload.tool_choice.type === "custom" && this.modes.custom) ||
          (payload.tool_choice.type === "tool_search" && this.modes.search))
      ) {
        const chosen = this.codec.resolve(payload.tool_choice);
        translated.tool_choice = {
          ...payload.tool_choice,
          type: "function",
          name: chosen.wire,
          ...(chosen.wireNamespace === undefined ? {} : { namespace: chosen.wireNamespace }),
        };
      }
      return translated;
    });
  }

  /** Translate one SSE or bridged WebSocket event; a buffered call can produce 0–3 events. */
  event(eventData: string): string[] {
    let event: unknown;
    try {
      event = JSON.parse(eventData);
    } catch {
      return [eventData];
    }
    if (!record(event)) return [eventData];
    return this.guard(() => this.translateEvent(event).map((value) => this.serialize(value)));
  }

  /** The same output mapping for a non-streamed Responses JSON body. */
  response(body: unknown): unknown {
    if (!record(body) || !Array.isArray(body.output)) return body;
    const output = body.output as unknown[];
    return this.guard(() => ({ ...body, output: output.map((item) => this.completeItem(item)) }));
  }

  private translateEvent(event: JsonObject): JsonObject[] {
    if (event.type === "response.output_item.added" && record(event.item)) {
      const item = event.item;
      const tool = this.translatedTool(item);
      if (!tool) return [{ ...event, item: this.markPlaintextMessage(item) }];
      if (typeof item.call_id !== "string") throw new Error("Translated tool call lacks call_id");
      const state: CallState = { tool, callId: item.call_id, arguments: "", inputEmitted: false };
      if (typeof item.id === "string") this.callsById.set(item.id, state);
      if (typeof event.output_index === "number") this.callsByIndex.set(event.output_index, state);
      const decoded = this.codec.decode(this.wireCall(state));
      const { arguments: _arguments, name: _name, namespace: _namespace, ...rest } = item;
      return [{ ...event, item: { ...rest, ...decoded } }];
    }
    if (event.type === "response.function_call_arguments.delta") {
      const state = this.callState(event);
      if (!state) return [event];
      if (typeof event.delta === "string") state.arguments += event.delta;
      return [];
    }
    if (event.type === "response.function_call_arguments.done") {
      const state = this.callState(event);
      if (!state) return [event];
      if (state.tool.search) {
        state.arguments = this.argumentsText(event.arguments, state.arguments);
        return [];
      }
      return this.inputEvents(event, state, this.argumentsText(event.arguments, state.arguments));
    }
    if (event.type === "response.output_item.done" && record(event.item)) {
      const tool = this.translatedTool(event.item);
      if (!tool) return [{ ...event, item: this.markPlaintextMessage(event.item) }];
      const state = this.callState(event);
      const argumentsText = this.argumentsText(event.item.arguments, state?.arguments);
      const item = this.completeItem(event.item, argumentsText);
      const inputEvents =
        tool.search || state?.inputEmitted
          ? []
          : this.inputEvents(
              event,
              state ?? {
                tool,
                callId: String(event.item.call_id),
                arguments: argumentsText,
                inputEmitted: false,
              },
              argumentsText,
            );
      return [...inputEvents, { ...event, item }];
    }
    if (event.type === "response.completed" && record(event.response)) {
      return [{ ...event, response: this.response(event.response) }];
    }
    return [event];
  }

  private translatedTool(item: JsonObject): MappedTool | undefined {
    if (item.type !== "function_call") return undefined;
    const tool = this.codec.byWire(item.name, item.namespace);
    return tool && ((this.modes.custom && tool.custom) || (this.modes.search && tool.search))
      ? tool
      : undefined;
  }

  private markPlaintextMessage(item: JsonObject): JsonObject {
    if (item.type !== "function_call") return item;
    const tool = this.codec.byWire(item.name, item.namespace);
    return tool?.plaintextMessage && !Object.hasOwn(item, "encrypted_function_args")
      ? { ...item, encrypted_function_args: [] }
      : item;
  }

  private callState(event: JsonObject): CallState | undefined {
    const id = record(event.item) ? event.item.id : event.item_id;
    if (typeof id === "string" && this.callsById.has(id)) return this.callsById.get(id);
    return typeof event.output_index === "number"
      ? this.callsByIndex.get(event.output_index)
      : undefined;
  }

  private argumentsText(value: unknown, fallback?: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    if (fallback) return fallback;
    if (typeof value === "string") return value;
    throw new Error("Translated tool call lacks completed arguments");
  }

  private wireCall(state: CallState, input?: unknown) {
    return {
      name: state.tool.wire,
      ...(state.tool.wireNamespace === undefined ? {} : { namespace: state.tool.wireNamespace }),
      callId: state.callId,
      ...(input === undefined ? {} : { input }),
    };
  }

  private decodedInput(state: CallState, argumentsText: string): string {
    const parsed: unknown = JSON.parse(argumentsText);
    const decoded = this.codec.decode(this.wireCall(state, parsed));
    return String(decoded.input);
  }

  private inputEvents(event: JsonObject, state: CallState, argumentsText: string): JsonObject[] {
    if (state.inputEmitted) return [];
    const input = this.decodedInput(state, argumentsText);
    state.inputEmitted = true;
    const fields = {
      ...(event.item_id === undefined && record(event.item)
        ? { item_id: event.item.id }
        : { item_id: event.item_id }),
      ...(event.output_index === undefined ? {} : { output_index: event.output_index }),
    };
    return [
      { type: "response.custom_tool_call_input.delta", ...fields, delta: input },
      { type: "response.custom_tool_call_input.done", ...fields, input },
    ];
  }

  private completeItem(item: unknown, argumentsText?: string): unknown {
    if (!record(item)) return item;
    const tool = this.translatedTool(item);
    if (!tool) return this.markPlaintextMessage(item);
    if (typeof item.call_id !== "string") throw new Error("Translated tool call lacks call_id");
    const parsed: unknown = JSON.parse(argumentsText ?? this.argumentsText(item.arguments));
    const decoded = this.codec.decode(
      this.wireCall(
        {
          tool,
          callId: item.call_id,
          arguments: "",
          inputEmitted: false,
        },
        parsed,
      ),
    );
    const { arguments: _arguments, name: _name, namespace: _namespace, ...rest } = item;
    return { ...rest, ...decoded };
  }

  private serialize(event: JsonObject): string {
    return JSON.stringify({ ...event, sequence_number: this.sequence++ });
  }

  private guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof ToolPolicyError) throw error;
      this.fail(error);
    }
  }

  private fail(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolPolicyError(
      `model route "${this.routeSlug}" tool translation failed: ${message}`,
    );
  }
}

export function createResponsesToolBridge(
  route: Pick<ModelRoute, "api" | "model" | "toolPolicy">,
  declarations: unknown,
): ResponsesToolBridge | undefined {
  if (route.api === "anthropic-messages") return undefined;
  const modes = {
    custom: route.toolPolicy.custom === "translate",
    search: route.toolPolicy.tool_search === "translate",
  };
  return modes.custom || modes.search
    ? new ResponsesToolBridge(route.model.slug, declarations, modes)
    : undefined;
}

export function translateResponsesStream(
  body: ReadableStream<Uint8Array>,
  bridge: ResponsesToolBridge,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = (async function* () {
    for await (const event of parseSseEvents(body)) {
      for (const translated of bridge.event(event)) {
        yield encoder.encode(`data: ${translated}\n\n`);
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

import { randomUUID } from "node:crypto";
import { parseSseEvents } from "../responses-bridge.ts";
import type { MappedTool } from "../tool-codec.ts";
import { record, text, type Json } from "./envelope.ts";
import type { PreparedAnthropic } from "./request.ts";

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
interface Block {
  value: Json;
  item: Json;
  outputIndex: number;
  json: string;
  tool?: MappedTool;
  stopped: boolean;
}

/** Incremental, index-keyed state. Completion is never synthesized on EOF or stream failure. */
export class AnthropicResponse {
  readonly output: Json[] = [];
  private readonly blocks = new Map<number, Block>();
  private usage: Json = {};
  private sequence = 0;
  private started = false;
  private ended = false;
  private stopReason: string | undefined;
  private bytes = 0;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly prepared: PreparedAnthropic;
  private readonly slug: string;
  constructor(prepared: PreparedAnthropic, slug: string) {
    this.prepared = prepared;
    this.slug = slug;
  }

  private event(type: string, fields: Json = {}): string {
    return JSON.stringify({ type, sequence_number: this.sequence++, ...fields });
  }
  private response(status: string): Json {
    const fresh = Number(this.usage.input_tokens ?? 0);
    const read = Number(this.usage.cache_read_input_tokens ?? 0);
    const write = Number(this.usage.cache_creation_input_tokens ?? 0);
    const output = Number(this.usage.output_tokens ?? 0);
    const details = record(this.usage.output_tokens_details)
      ? this.usage.output_tokens_details
      : {};
    return {
      id: "",
      object: "response",
      created_at: this.createdAt,
      model: this.slug,
      status,
      output: this.output,
      usage: {
        input_tokens: fresh + read + write,
        output_tokens: output,
        total_tokens: fresh + read + write + output,
        input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
        output_tokens_details: { reasoning_tokens: Number(details.thinking_tokens ?? 0) },
      },
    };
  }
  accept(event: Json): string[] {
    if (this.ended) throw new Error("Event received after Anthropic message_stop");
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bytes > MAX_STREAM_BYTES) throw new Error("Anthropic response exceeds 32 MiB");
    switch (event.type) {
      case "ping":
        return [];
      case "error": {
        this.ended = true;
        const error = record(event.error) ? event.error : {};
        const code =
          error.type === "rate_limit_error"
            ? "rate_limit_exceeded"
            : error.type === "overloaded_error" || error.type === "api_error"
              ? "anthropic_overloaded"
              : "upstream_error";
        return [
          this.event("response.failed", {
            response: {
              ...this.response("failed"),
              error: { code, message: text(error.message, "Anthropic stream failed") },
            },
          }),
        ];
      }
      case "message_start": {
        if (this.started || !record(event.message))
          throw new Error("Invalid Anthropic message_start");
        this.started = true;
        if (record(event.message.usage)) this.usage = { ...event.message.usage };
        return [this.event("response.created", { response: this.response("in_progress") })];
      }
      case "content_block_start": {
        if (
          !this.started ||
          !Number.isInteger(event.index) ||
          !record(event.content_block) ||
          this.blocks.has(Number(event.index))
        )
          throw new Error("Invalid Anthropic content_block_start");
        const value = { ...event.content_block };
        const outputIndex = this.output.length;
        const itemId = `${value.type === "tool_use" ? "fc" : value.type === "text" ? "msg" : "rs"}_${randomUUID()}`;
        let item: Json;
        let tool: MappedTool | undefined;
        if (value.type === "text")
          item = {
            type: "message",
            id: itemId,
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: text(value.text), annotations: [] }],
          };
        else if (value.type === "thinking" || value.type === "redacted_thinking")
          item = { type: "reasoning", id: itemId, summary: [] };
        else if (value.type === "tool_use") {
          tool = this.prepared.codec.byWire(value.name);
          if (!tool) throw new Error(`Anthropic returned unknown tool: ${String(value.name)}`);
          if (typeof value.id !== "string") throw new Error("Anthropic tool call lacks id");
          item = {
            ...this.prepared.codec.decode({ name: tool.wire, callId: value.id }),
            id: itemId,
            status: "in_progress",
          };
        } else throw new Error(`Unsupported Anthropic response block: ${String(value.type)}`);
        this.output.push(item);
        this.blocks.set(Number(event.index), {
          value,
          item,
          outputIndex,
          json: "",
          tool,
          stopped: false,
        });
        if (this.prepared.compact) return [];
        const events = [
          this.event("response.output_item.added", {
            output_index: outputIndex,
            item: structuredClone(item),
          }),
        ];
        if (value.type === "text")
          events.push(
            this.event("response.content_part.added", {
              output_index: outputIndex,
              item_id: itemId,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }),
          );
        if (value.type === "thinking")
          events.push(
            this.event("response.reasoning_summary_part.added", {
              output_index: outputIndex,
              item_id: itemId,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            }),
          );
        return events;
      }
      case "content_block_delta": {
        const block = this.blocks.get(Number(event.index));
        if (!block || block.stopped || !record(event.delta))
          throw new Error("Invalid Anthropic content_block_delta");
        const delta = event.delta;
        const fields = { item_id: block.item.id, output_index: block.outputIndex };
        if (delta.type === "text_delta" && block.value.type === "text") {
          block.value.text = text(block.value.text) + text(delta.text);
          return this.prepared.compact
            ? []
            : [
                this.event("response.output_text.delta", {
                  ...fields,
                  content_index: 0,
                  delta: delta.text,
                }),
              ];
        }
        if (delta.type === "thinking_delta" && block.value.type === "thinking") {
          block.value.thinking = text(block.value.thinking) + text(delta.thinking);
          return this.prepared.compact
            ? []
            : [
                this.event("response.reasoning_summary_text.delta", {
                  ...fields,
                  summary_index: 0,
                  delta: delta.thinking,
                }),
              ];
        }
        if (delta.type === "signature_delta" && block.value.type === "thinking") {
          block.value.signature = text(block.value.signature) + text(delta.signature);
          return [];
        }
        if (delta.type === "input_json_delta" && block.value.type === "tool_use") {
          block.json += text(delta.partial_json);
          // Custom tools wrap a JSON string; emit raw input only once it is complete/unescaped.
          return this.prepared.compact ||
            block.tool?.custom ||
            block.tool?.search ||
            block.tool?.wrapped
            ? []
            : [
                this.event("response.function_call_arguments.delta", {
                  ...fields,
                  delta: delta.partial_json,
                }),
              ];
        }
        throw new Error(`Unsupported Anthropic delta: ${String(delta.type)}`);
      }
      case "content_block_stop": {
        const block = this.blocks.get(Number(event.index));
        if (!block || block.stopped) throw new Error("Invalid Anthropic content_block_stop");
        block.stopped = true;
        if (block.value.type === "text")
          block.item.content = [
            { type: "output_text", text: text(block.value.text), annotations: [] },
          ];
        else if (block.value.type === "tool_use") {
          const input: unknown = block.json ? JSON.parse(block.json) : block.value.input;
          if (!record(input)) throw new Error("Anthropic tool arguments are not a JSON object");
          const decoded = this.prepared.codec.decode({
            name: block.tool!.wire,
            callId: String(block.item.call_id),
            input,
          });
          if (block.tool?.custom) block.item.input = decoded.input;
          else block.item.arguments = decoded.arguments;
        } else {
          if (block.value.type === "thinking" && !block.value.signature)
            throw new Error("Anthropic thinking block lacks its replay signature");
          block.item.summary =
            block.value.type === "thinking"
              ? [{ type: "summary_text", text: block.value.thinking ?? "" }]
              : [];
          block.item.encrypted_content = this.prepared.envelope.seal({
            kind: "thinking",
            model: this.prepared.model,
            blocks: [block.value],
          });
        }
        if (block.item.type !== "reasoning") block.item.status = "completed";
        return [];
      }
      case "message_delta": {
        if (record(event.usage)) this.usage = { ...this.usage, ...event.usage };
        if (record(event.delta) && typeof event.delta.stop_reason === "string")
          this.stopReason = event.delta.stop_reason;
        return [];
      }
      case "message_stop": {
        if (!this.started || !this.stopReason || [...this.blocks.values()].some((b) => !b.stopped))
          throw new Error("Incomplete Anthropic message");
        this.ended = true;
        if (this.stopReason === "max_tokens" || this.stopReason === "model_context_window_exceeded")
          return [
            this.event("response.incomplete", {
              response: {
                ...this.response("incomplete"),
                incomplete_details: {
                  reason:
                    this.stopReason === "max_tokens"
                      ? "max_output_tokens"
                      : "context_length_exceeded",
                },
              },
            }),
          ];
        if (
          !["end_turn", "tool_use", "stop_sequence", "refusal", "pause_turn"].includes(
            this.stopReason,
          )
        )
          throw new Error(`Unsupported stop reason: ${this.stopReason}`);
        if (this.stopReason === "pause_turn")
          throw new Error(
            "Anthropic paused a server-side tool turn, which this route does not support",
          );
        if (this.prepared.compact) {
          const summary = [...this.blocks.values()]
            .filter((b) => b.value.type === "text")
            .map((b) => text(b.value.text))
            .join("\n");
          if (!summary.trim()) throw new Error("Anthropic returned an empty compaction summary");
          this.output.splice(0, this.output.length, {
            id: `cmp_${randomUUID()}`,
            type: "compaction",
            encrypted_content: this.prepared.envelope.seal({ kind: "compaction", summary }),
          });
          return [
            this.event("response.output_item.added", { output_index: 0, item: this.output[0] }),
            this.event("response.output_item.done", { output_index: 0, item: this.output[0] }),
            this.event("response.completed", { response: this.response("completed") }),
          ];
        }
        const events: string[] = [];
        for (const block of this.blocks.values()) {
          const fields = { output_index: block.outputIndex, item_id: block.item.id };
          if (block.item.type === "message") {
            const part = (block.item.content as Json[])[0]!;
            events.push(
              this.event("response.output_text.done", {
                ...fields,
                content_index: 0,
                text: part.text,
              }),
              this.event("response.content_part.done", { ...fields, content_index: 0, part }),
            );
          } else if (block.tool?.custom) {
            events.push(
              this.event("response.custom_tool_call_input.delta", {
                ...fields,
                delta: block.item.input,
              }),
              this.event("response.custom_tool_call_input.done", {
                ...fields,
                input: block.item.input,
              }),
            );
          } else if (block.tool && !block.tool.search) {
            if (block.tool.wrapped)
              events.push(
                this.event("response.function_call_arguments.delta", {
                  ...fields,
                  delta: block.item.arguments,
                }),
              );
            events.push(
              this.event("response.function_call_arguments.done", {
                ...fields,
                arguments: block.item.arguments,
              }),
            );
          } else if (block.value.type === "thinking")
            events.push(
              this.event("response.reasoning_summary_text.done", {
                ...fields,
                summary_index: 0,
                text: block.value.thinking,
              }),
            );
          events.push(
            this.event("response.output_item.done", {
              output_index: block.outputIndex,
              item: block.item,
            }),
          );
        }
        events.push(this.event("response.completed", { response: this.response("completed") }));
        return events;
      }
      default:
        throw new Error(`Unsupported Anthropic event: ${String(event.type)}`);
    }
  }
  finish(): void {
    if (!this.ended) throw new Error("Anthropic stream closed before message_stop");
  }
  failure(error: unknown): string {
    return this.event("response.failed", {
      response: {
        ...this.response("failed"),
        error: {
          code: "upstream_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  }
}

export async function* anthropicEvents(
  response: Response,
  prepared: PreparedAnthropic,
  slug: string,
): AsyncGenerator<string> {
  const state = new AnthropicResponse(prepared, slug);
  try {
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      if (!response.body) throw new Error("Missing Anthropic response body");
      for await (const data of parseSseEvents(response.body)) {
        const event: unknown = JSON.parse(data);
        if (!record(event)) throw new Error("Invalid Anthropic event");
        yield* state.accept(event);
        if (event.type === "message_stop" || event.type === "error") break;
      }
    } else {
      const message: unknown = await response.json();
      if (!record(message) || !Array.isArray(message.content))
        throw new Error("Invalid Anthropic JSON response");
      yield* state.accept({ type: "message_start", message });
      for (const [index, content] of message.content.entries()) {
        yield* state.accept({ type: "content_block_start", index, content_block: content });
        yield* state.accept({ type: "content_block_stop", index });
      }
      yield* state.accept({
        type: "message_delta",
        delta: { stop_reason: message.stop_reason },
        usage: message.usage,
      });
      yield* state.accept({ type: "message_stop" });
    }
    state.finish();
  } catch (error) {
    yield state.failure(error);
  }
}

export function eventsResponse(events: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`data: ${next.value}\n\n`));
      },
      async cancel() {
        await events.return(undefined);
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  );
}

import { randomUUID } from "node:crypto";
import type { TargetBreakers } from "../../routing/failover.ts";
import type { ModelRoute } from "../../routing/model-routes.ts";
import { brokerToolResult, runSearchBroker, type BrokerResult } from "../search-broker.ts";
import { record, type Json } from "./envelope.ts";
import type { PreparedAnthropic } from "./request.ts";
import { AnthropicResponse, anthropicEvents } from "./response.ts";

const MAX_BROKER_ROUNDS = 3;
const MAX_BROKER_CALLS = 6;

export interface BrokerContext {
  route: ModelRoute;
  breakers: TargetBreakers;
  onResult?: (result: BrokerResult) => void;
}

/** Combines Claude's tool-use rounds into one Codex Responses stream. */
export async function* brokeredAnthropicEvents(
  initial: Response,
  url: URL,
  headers: Headers,
  prepared: PreparedAnthropic,
  slug: string,
  broker: BrokerContext,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const output: Json[] = [];
  let sequence = 0;
  let response = initial;
  let usage: Json | undefined;
  let brokerCalls = 0;
  const emit = (event: Json) => JSON.stringify({ ...event, sequence_number: sequence++ });
  for (let round = 0; ; round++) {
    const state = new AnthropicResponse(prepared, slug);
    const offset = output.length;
    const deferredDone: Json[] = [];
    let terminal: Json | undefined;
    for await (const raw of anthropicEvents(response, prepared, slug, state)) {
      const event = JSON.parse(raw) as Json;
      if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        terminal = event;
        continue;
      }
      if (event.type === "response.created" && round > 0) continue;
      const shifted = {
        ...event,
        ...(typeof event.output_index === "number"
          ? { output_index: event.output_index + offset }
          : {}),
      };
      if (
        event.type === "response.output_item.done" &&
        record(event.item) &&
        event.item.type === "web_search_call"
      )
        deferredDone.push(shifted);
      else yield emit(shifted);
    }
    if (!terminal || !record(terminal.response))
      throw new Error("Anthropic broker turn ended without a terminal response");
    const completed = terminal.response;
    const roundOutput = Array.isArray(completed.output) ? (completed.output as Json[]) : [];
    output.push(...roundOutput);
    usage = sumUsage(usage, record(completed.usage) ? completed.usage : {});
    if (terminal.type !== "response.completed") {
      yield emit({ ...terminal, response: { ...completed, output, usage } });
      return;
    }
    if (state.brokerUses.length === 0) {
      yield emit({ type: "response.completed", response: { ...completed, output, usage } });
      return;
    }
    if (round >= MAX_BROKER_ROUNDS) {
      yield emit({
        type: "response.failed",
        response: {
          ...completed,
          status: "failed",
          output,
          usage,
          error: {
            code: "web_search_limit",
            message: "Anthropic web search broker round limit reached",
          },
        },
      });
      return;
    }
    const results: Json[] = [];
    for (const use of state.brokerUses) {
      const result =
        brokerCalls++ >= MAX_BROKER_CALLS
          ? {
              text: "",
              sources: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              error: "Web search broker call limit reached",
            }
          : await runSearchBroker(
              broker.route,
              use.query,
              broker.breakers,
              signal,
              prepared.webSearchDeclaration,
            );
      broker.onResult?.(result);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: [{ type: "text", text: brokerToolResult(result) }],
        ...(result.error ? { is_error: true } : {}),
      });
      const done = deferredDone.find((event) => record(event.item) && event.item.id === use.itemId);
      if (done) yield emit(done);
    }
    const uses: Json[] = state.brokerUses.map((use) => ({
      type: "tool_use",
      id: use.id,
      name: use.name,
      input: use.input,
    }));
    const marker: Json = {
      type: "reasoning",
      id: `rs_${randomUUID()}`,
      summary: [],
      encrypted_content: prepared.envelope.seal({ kind: "broker", uses, results }),
    };
    const markerIndex = output.length;
    output.push(marker);
    yield emit({ type: "response.output_item.added", output_index: markerIndex, item: marker });
    yield emit({ type: "response.output_item.done", output_index: markerIndex, item: marker });

    const externalCalls = roundOutput.some(
      (item) =>
        record(item) &&
        (item.type === "function_call" ||
          item.type === "custom_tool_call" ||
          item.type === "tool_search_call"),
    );
    if (externalCalls) {
      yield emit({ type: "response.completed", response: { ...completed, output, usage } });
      return;
    }
    const messages = prepared.body.messages;
    if (!Array.isArray(messages)) throw new Error("Invalid Anthropic broker messages");
    messages.push({ role: "assistant", content: state.assistantBlocks() });
    messages.push({ role: "user", content: results });
    prepared.body.tool_choice = { type: "auto" };
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(prepared.body),
      signal,
      redirect: "manual",
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      yield emit({
        type: "response.failed",
        response: {
          ...completed,
          status: "failed",
          output,
          usage,
          error: {
            code: "upstream_error",
            message: `Anthropic continuation HTTP ${response.status}: ${detail}`,
          },
        },
      });
      return;
    }
  }
}

function sumUsage(total: Json | undefined, next: Json): Json {
  if (!total) return structuredClone(next);
  const add = (key: string) => Number(total[key] ?? 0) + Number(next[key] ?? 0);
  const totalInput = record(total.input_tokens_details) ? total.input_tokens_details : {};
  const nextInput = record(next.input_tokens_details) ? next.input_tokens_details : {};
  const totalOutput = record(total.output_tokens_details) ? total.output_tokens_details : {};
  const nextOutput = record(next.output_tokens_details) ? next.output_tokens_details : {};
  return {
    input_tokens: add("input_tokens"),
    output_tokens: add("output_tokens"),
    total_tokens: add("total_tokens"),
    input_tokens_details: {
      cached_tokens: Number(totalInput.cached_tokens ?? 0) + Number(nextInput.cached_tokens ?? 0),
      cache_write_tokens:
        Number(totalInput.cache_write_tokens ?? 0) + Number(nextInput.cache_write_tokens ?? 0),
    },
    output_tokens_details: {
      reasoning_tokens:
        Number(totalOutput.reasoning_tokens ?? 0) + Number(nextOutput.reasoning_tokens ?? 0),
    },
  };
}

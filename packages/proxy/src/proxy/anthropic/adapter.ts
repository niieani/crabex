import type { ModelRoute } from "../../routing/model-routes.ts";
import { AnthropicRequestError, record } from "./envelope.ts";
import { prepareAnthropic } from "./request.ts";
import { anthropicEvents, eventsResponse } from "./response.ts";
import { brokeredAnthropicEvents, type BrokerContext } from "./broker.ts";

/** Fetch-compatible seam: upstream attempts return Responses, before retry/commit inspection. */
export function anthropicFetch(
  route: ModelRoute,
  key: Uint8Array,
  signal?: AbortSignal,
  legacyCompact = false,
  broker?: BrokerContext,
) {
  return async (url: URL, init: RequestInit): Promise<Response> => {
    try {
      if (typeof init.body !== "string")
        throw new AnthropicRequestError("Expected serialized Responses request");
      const payload: unknown = JSON.parse(init.body);
      if (!record(payload)) throw new AnthropicRequestError("Invalid Responses request");
      const prepared = prepareAnthropic(payload, route, key, legacyCompact);
      const incoming = new Headers(init.headers);
      const headers = new Headers({
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
      });
      const authorization = incoming.get("authorization") ?? "";
      if (route.anthropic?.auth === "api-key")
        headers.set("x-api-key", authorization.replace(/^Bearer /, ""));
      else headers.set("authorization", authorization);
      const beta = new Set(route.anthropic?.beta ?? []);
      if (route.anthropic?.drop_mismatched_thinking)
        beta.add("thinking-binding-controls-2026-08-01");
      if (beta.size) headers.set("anthropic-beta", [...beta].join(","));
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(prepared.body),
        signal,
        redirect: "manual",
      });
      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
          const body: unknown = JSON.parse(text);
          if (record(body) && record(body.error) && typeof body.error.message === "string")
            message = body.error.message;
        } catch {
          /* retain upstream error */
        }
        return Response.json(
          {
            error: {
              code: response.status === 429 ? "rate_limit_exceeded" : "upstream_error",
              message,
            },
          },
          { status: response.status },
        );
      }
      const events =
        broker && prepared.codec.tools.some((tool) => tool.broker) && !legacyCompact
          ? brokeredAnthropicEvents(
              response,
              url,
              headers,
              prepared,
              route.model.slug,
              broker,
              signal,
            )
          : anthropicEvents(response, prepared, route.model.slug);
      if (payload.stream === true && !legacyCompact) return eventsResponse(events);
      for await (const data of events) {
        const event = JSON.parse(data);
        if (event.type === "response.completed") {
          const result = event.response;
          if (legacyCompact) {
            // Legacy compaction replaces all history; preserve the latest image-bearing user turn.
            const retained = Array.isArray(payload.input)
              ? payload.input
                  .filter(
                    (item) =>
                      record(item) &&
                      item.role === "user" &&
                      Array.isArray(item.content) &&
                      item.content.some((part) => record(part) && part.type === "input_image"),
                  )
                  .slice(-1)
              : [];
            return Response.json({
              id: "",
              object: "response.compaction",
              created_at: result.created_at,
              output: [...retained, ...result.output],
              usage: result.usage,
            });
          }
          return Response.json(result);
        }
        if (event.type === "response.failed" || event.type === "response.incomplete")
          return Response.json(event.response, { status: 502 });
      }
      throw new Error("Anthropic stream ended without completion");
    } catch (error) {
      if (error instanceof AnthropicRequestError)
        return Response.json(
          { error: { code: "invalid_request_error", message: error.message } },
          { status: error.status },
        );
      throw error;
    }
  };
}

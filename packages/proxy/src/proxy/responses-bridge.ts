/**
 * Bridges Codex's Responses-over-WebSocket protocol to an HTTP-only
 * OpenAI-compatible upstream: each `response.create` message becomes a
 * streaming POST /responses, and the SSE event stream is forwarded back as
 * WebSocket messages. Both transports share the Responses event vocabulary,
 * so events pass through as near-verbatim JSON.
 */

/** Fields that only exist on the WebSocket wire and must not reach HTTP. */
const WS_ONLY_REQUEST_FIELDS = new Set(["type", "client_metadata", "generate"]);

/** Strips WebSocket-only envelope fields from a response.create payload. */
export function httpPayloadFor(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !WS_ONLY_REQUEST_FIELDS.has(key)),
  );
}

/**
 * Best-effort rewrite of `response.model` in a streamed event so the client
 * keeps seeing the advertised slug rather than the upstream's model name.
 * Unparseable events pass through untouched.
 */
export function rewriteResponseModel(eventData: string, advertisedSlug: string): string {
  try {
    const parsed: unknown = JSON.parse(eventData);
    if (typeof parsed !== "object" || parsed === null) return eventData;
    const event = parsed as Record<string, unknown>;
    const response = event.response;
    if (
      typeof response === "object" &&
      response !== null &&
      typeof (response as { model?: unknown }).model === "string"
    ) {
      (response as { model: unknown }).model = advertisedSlug;
    }
    return JSON.stringify(event);
  } catch {
    return eventData;
  }
}

/**
 * Synthesizes the wrapped error event Codex's WebSocket client expects for
 * transport-level failures (`{"type":"error","status":N,"error":{...}}`),
 * which it maps onto the same error path as a plain HTTP error response.
 * Used when the upstream never started streaming.
 */
export function wrappedErrorEvent(status: number, detail: string): string {
  let code = `http_${status}`;
  let message = detail;
  try {
    const parsed: unknown = JSON.parse(detail);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.length > 0) message = error.message;
    if (typeof error?.code === "string" && error.code.length > 0) code = error.code;
  } catch {
    // keep the raw body as the message
  }
  return JSON.stringify({ type: "error", status, error: { code, message } });
}

/**
 * Incremental SSE parser: yields the `data` payload of each event. Comment
 * lines, `event:` lines, and the `[DONE]` sentinel are skipped — the data
 * JSON carries the Responses event type itself.
 */
export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  function* flush(): Generator<string, void, undefined> {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    yield data;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          yield* flush();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // event:, id:, retry: and comment lines carry nothing we need
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

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
/**
 * Synthetic frames answering a `generate: false` warmup create locally, so the
 * handshake never reaches the upstream (a stripped warmup would otherwise bill
 * a real generation). Frame shape mirrors opencodex's
 * buildWarmupCompletionFrames (MIT).
 */
export function warmupCompletionEvents(model: string): string[] {
  const baseResponse: Record<string, unknown> = {
    id: "",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [],
  };
  return [
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: { ...baseResponse, status: "in_progress" },
    }),
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: { ...baseResponse, status: "completed" },
    }),
  ];
}

export function httpPayloadFor(
  payload: Record<string, unknown>,
  options: {
    forwardAccessPrograms?: boolean;
    allowedToolTypes?: readonly string[];
    storeResponses?: boolean;
  } = {},
): Record<string, unknown> {
  const request = Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      if (WS_ONLY_REQUEST_FIELDS.has(key)) return false;
      return key !== "access_programs" || options.forwardAccessPrograms === true;
    }),
  );
  const allowedToolTypes = options.allowedToolTypes;
  if (allowedToolTypes !== undefined && Array.isArray(request.tools)) {
    request.tools = request.tools.filter(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        typeof (tool as { type?: unknown }).type === "string" &&
        allowedToolTypes.includes((tool as { type: string }).type),
    );
  }
  if (options.storeResponses === true) request.store = true;
  return request;
}

/**
 * Best-effort rewrite of a streamed event's `response` object for bridged
 * (HTTP upstream) routes:
 *
 * - `model` becomes the advertised slug, so the client keeps seeing the model
 *   it asked for rather than the upstream's name.
 * - `id` is blanked by default. Bridged upstreams are stateless for our purposes — ZDR
 *   orgs reject `previous_response_id` outright ("Previous response cannot be
 *   used for this organization due to Zero Data Retention"), and gateways
 *   generally don't persist responses. Codex only chains tool-call
 *   continuations via `previous_response_id` when the last response id is
 *   non-empty; an empty id makes it replay the full input instead
 *   (core/src/client.rs `prepare_websocket_request`; opencodex does the same
 *   with `forceEmptyResponseId`). Stored-response routes preserve the ID.
 *
 * Unparseable events pass through untouched.
 */
export function rewriteBridgedEvent(
  eventData: string,
  advertisedSlug: string,
  options: { preserveResponseId?: boolean } = {},
): string {
  try {
    const parsed: unknown = JSON.parse(eventData);
    if (typeof parsed !== "object" || parsed === null) return eventData;
    const event = parsed as Record<string, unknown>;
    const response = event.response;
    if (typeof response === "object" && response !== null) {
      const r = response as { model?: unknown; id?: unknown };
      if (typeof r.model === "string") r.model = advertisedSlug;
      if (typeof r.id === "string" && options.preserveResponseId !== true) r.id = "";
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
const STREAM_RETRY_CODES = new Set(["rate_limit_exceeded"]);
const STREAM_ERROR_TYPES = new Set(["error", "response.failed", "response.error"]);

/** HTTP status used when an SSE error should retry/fail over like that status. */
export function eventStreamRetryStatus(eventData: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(eventData);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const event = parsed as Record<string, unknown>;
    if (typeof event.type === "string" && !STREAM_ERROR_TYPES.has(event.type)) return undefined;
    const nested =
      (typeof event.error === "object" && event.error !== null
        ? (event.error as { code?: unknown })
        : undefined) ??
      (typeof event.response === "object" &&
      event.response !== null &&
      typeof (event.response as { error?: unknown }).error === "object" &&
      (event.response as { error?: unknown }).error !== null
        ? (event.response as { error: { code?: unknown } }).error
        : undefined);
    const code = typeof nested?.code === "string" ? nested.code : event.code;
    return typeof code === "string" && STREAM_RETRY_CODES.has(code) ? 429 : undefined;
  } catch {
    return undefined;
  }
}

function hasStreamOutput(eventData: string): boolean {
  try {
    const type = (JSON.parse(eventData) as { type?: unknown }).type;
    return (
      type === "response.completed" ||
      (typeof type === "string" && type.startsWith("response.output"))
    );
  } catch {
    return false;
  }
}

function streamEventType(eventData: string): string | undefined {
  try {
    const type = (JSON.parse(eventData) as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * After an HTTP 200, look at the SSE stream before committing the attempt.
 * `rate_limit_exceeded` before any output is a 429-equivalent; otherwise the
 * original events are replayed so the caller can forward them.
 */
export async function resolveEventStreamResponse(
  response: Response,
): Promise<{ kind: "ok"; response: Response } | { kind: "retry"; status: number }> {
  if (response.body === null) return { kind: "ok", response };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return { kind: "ok", response };

  const buffered: string[] = [];
  const iterator = parseSseEvents(response.body);
  // Use next() so a successful commit does not close the iterator. `for await`
  // would call return() on the way out and drop the rest of the SSE stream.
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const event = next.value;
    buffered.push(event);
    const retryStatus = eventStreamRetryStatus(event);
    if (retryStatus !== undefined && !buffered.some((item) => hasStreamOutput(item))) {
      await iterator.return(undefined);
      return { kind: "retry", status: retryStatus };
    }
    if (hasStreamOutput(event)) {
      return { kind: "ok", response: replaySseResponse(response, buffered, iterator) };
    }
    const type = streamEventType(event);
    if (type !== undefined && STREAM_ERROR_TYPES.has(type)) {
      return { kind: "ok", response: replaySseResponse(response, buffered, iterator) };
    }
  }
  return { kind: "ok", response: replaySseResponse(response, buffered) };
}

function replaySseResponse(
  original: Response,
  buffered: string[],
  rest?: AsyncGenerator<string>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const event of buffered) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        }
        if (rest !== undefined) {
          for await (const event of rest) {
            controller.enqueue(encoder.encode(`data: ${event}\n\n`));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
}

export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const scanner = new SseEventScanner();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* scanner.push(value);
    }
    yield* scanner.finish();
  } finally {
    reader.releaseLock();
  }
}

/** Parses SSE events while callers retain the original response bytes. */
export class SseEventScanner {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.readLines();
  }

  finish(): string[] {
    this.buffer += this.decoder.decode();
    const events = this.readLines();
    if (this.buffer.length > 0) {
      this.acceptLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
    this.flush(events);
    return events;
  }

  private readLines(): string[] {
    const events: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return events;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") this.flush(events);
      else this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    if (line.startsWith("data:")) this.dataLines.push(line.slice(5).replace(/^ /, ""));
    // event:, id:, retry: and comment lines carry nothing we need.
  }

  private flush(events: string[]): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    if (data !== "[DONE]") events.push(data);
  }
}

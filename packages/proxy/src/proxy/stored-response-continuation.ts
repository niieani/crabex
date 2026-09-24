import { createHash } from "node:crypto";
import { PersistentLruCache } from "../config/persistent-lru-cache.ts";

type ExactMarker = { kind: "exact"; digest: string };
type InputMarker = ExactMarker | OutputMarker;
type OutputMarker = {
  kind: "output";
  type: string;
  id: string;
  callId?: string;
};

export interface StoredResponseState {
  routeSlug: string;
  responseId: string;
  inputMarkers: readonly InputMarker[];
  outputMarkers: readonly OutputMarker[];
}

export interface PreparedStoredRequest {
  payload: Record<string, unknown>;
  inputMarkers?: readonly InputMarker[];
}

const STATE_TTL_MS = 30 * 60_000;
const MAX_STORED_RESPONSES = 512;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
// Codex parses unknown response item types as Other and excludes them from replay.
// Fireworks can add a completion-only tool_output after a native web search.
const REPLAYED_OUTPUT_TYPES = new Set([
  "additional_tools",
  "agent_message",
  "compaction",
  "compaction_summary",
  "context_compaction",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "image_generation_call",
  "local_shell_call",
  "message",
  "reasoning",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);

/** The two Codex transport paths share these headers for one conversation. */
export function continuationSessionKey(headers: Headers): string | undefined {
  const sessionId = headers.get("session-id")?.trim();
  const threadId = headers.get("thread-id")?.trim();
  const accountId = headers.get("chatgpt-account-id")?.trim();
  const authorization = headers.get("authorization")?.trim();
  if (!sessionId || !threadId || (!accountId && !authorization)) return undefined;
  return digest([sessionId, threadId, accountId, authorization]);
}

/** Keep continuations apart when a route target or provider credential changes. */
export function storedResponseKey(
  sessionKey: string | undefined,
  routeSlug: string,
  targetUrl: string,
  targetModel: string,
  providerAuthorization: string,
): string | undefined {
  if (sessionKey === undefined) return undefined;
  return digest([sessionKey, routeSlug, targetUrl, targetModel, providerAuthorization]);
}

/** Bounded, short-lived state shared by WebSocket bridges and routed HTTP. */
export class StoredResponseRegistry {
  private readonly entries: PersistentLruCache<StoredResponseState>;

  constructor(
    now: () => number = Date.now,
    entries = new PersistentLruCache(responseCacheOptions(now)),
  ) {
    this.entries = entries;
  }

  static async open(path: string, now: () => number = Date.now): Promise<StoredResponseRegistry> {
    return new StoredResponseRegistry(
      now,
      await PersistentLruCache.open(path, responseCacheOptions(now)),
    );
  }

  get(key: string | undefined): StoredResponseState | undefined {
    if (key === undefined) return undefined;
    return this.entries.get(key);
  }

  set(key: string | undefined, state: StoredResponseState): void {
    if (key === undefined) return;
    this.entries.set(key, state);
  }

  flush(): Promise<void> {
    return this.entries.flush();
  }
}

function responseCacheOptions(now: () => number) {
  return {
    now,
    ttlMs: STATE_TTL_MS,
    maxEntries: MAX_STORED_RESPONSES,
    maxBytes: MAX_CACHE_BYTES,
    isValue: validStoredResponse,
  };
}

function validStoredResponse(value: unknown): value is StoredResponseState {
  return (
    isRecord(value) &&
    typeof value.routeSlug === "string" &&
    typeof value.responseId === "string" &&
    Array.isArray(value.inputMarkers) &&
    value.inputMarkers.every(validMarker) &&
    Array.isArray(value.outputMarkers) &&
    value.outputMarkers.every(validOutputMarker)
  );
}

function validMarker(value: unknown): value is InputMarker {
  return (
    isRecord(value) &&
    ((value.kind === "exact" && typeof value.digest === "string") || validOutputMarker(value))
  );
}

function validOutputMarker(value: unknown): value is OutputMarker {
  return (
    isRecord(value) &&
    value.kind === "output" &&
    typeof value.type === "string" &&
    typeof value.id === "string" &&
    (value.callId === undefined || typeof value.callId === "string")
  );
}

/**
 * Codex sometimes replays the whole input after a tool call because a request
 * property changed. When the replay matches the preceding stored response,
 * send only its new input with previous_response_id so the provider keeps the
 * preceding hidden reasoning. Exact input hashes and provider output IDs guard
 * against joining unrelated histories without retaining prompt text in memory.
 */
export function prepareStoredRequest(
  payload: Record<string, unknown>,
  routeSlug: string,
  previous?: StoredResponseState,
): PreparedStoredRequest {
  if (!Array.isArray(payload.input)) return { payload };
  const input = payload.input as unknown[];
  const sameRoute = previous?.routeSlug === routeSlug;
  const explicitId = payload.previous_response_id;
  if (typeof explicitId === "string" && explicitId.length > 0) {
    return {
      payload,
      inputMarkers:
        sameRoute && explicitId === previous.responseId
          ? [...previous.inputMarkers, ...previous.outputMarkers, ...input.map(exactMarker)]
          : input.map(exactMarker),
    };
  }

  const inputMarkers = input.map(exactMarker);
  if (!sameRoute) return { payload, inputMarkers };
  const prefix = [...previous.inputMarkers, ...previous.outputMarkers];
  if (
    input.length <= prefix.length ||
    !prefix.every((marker, index) => matchesMarker(marker, input[index]))
  ) {
    return { payload, inputMarkers };
  }
  return {
    payload: {
      ...payload,
      previous_response_id: previous.responseId,
      input: input.slice(prefix.length),
    },
    inputMarkers,
  };
}

/** Capture only the metadata needed to validate the next replay. */
export function completedStoredResponse(
  eventData: string,
  routeSlug: string,
  inputMarkers?: readonly InputMarker[],
): StoredResponseState | undefined {
  if (inputMarkers === undefined) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(eventData);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== "response.completed") return undefined;
  const response = event.response;
  if (
    !isRecord(response) ||
    typeof response.id !== "string" ||
    response.id.length === 0 ||
    !Array.isArray(response.output)
  ) {
    return undefined;
  }
  const outputMarkers = response.output.filter(replayedOutput).map(outputMarker);
  if (outputMarkers.some((marker) => marker === undefined)) return undefined;
  return {
    routeSlug,
    responseId: response.id,
    inputMarkers,
    outputMarkers: outputMarkers as OutputMarker[],
  };
}

function replayedOutput(item: unknown): boolean {
  return !isRecord(item) || typeof item.type !== "string" || REPLAYED_OUTPUT_TYPES.has(item.type);
}

function exactMarker(item: unknown): ExactMarker {
  return {
    kind: "exact",
    digest: digest(item),
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function outputMarker(item: unknown): OutputMarker | undefined {
  if (
    !isRecord(item) ||
    typeof item.type !== "string" ||
    typeof item.id !== "string" ||
    item.id.length === 0
  ) {
    return undefined;
  }
  return {
    kind: "output",
    type: item.type,
    id: item.id,
    ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}),
  };
}

function matchesMarker(marker: InputMarker, item: unknown): boolean {
  if (marker.kind === "exact") return marker.digest === exactMarker(item).digest;
  const current = outputMarker(item);
  return (
    current !== undefined &&
    current.type === marker.type &&
    current.id === marker.id &&
    current.callId === marker.callId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

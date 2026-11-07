const UPSTREAM_BASE = "/backend-api/codex";
const CLIENT_BASE = "/v1";
const MAX_TOOL_DEPTH = 8;

/** The whole backend surface a Client Key can reach, with the query parameters each may carry. */
const HTTP_ROUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ["POST /responses", []],
  ["POST /alpha/search", []],
  ["GET /models", ["client_version"]],
  ["POST /images/generations", []],
  ["POST /images/edits", []],
]);
const WEBSOCKET_ROUTES: ReadonlyMap<string, readonly string[]> = new Map([["/responses", []]]);

/** Fields Codex sends per tool type (`ToolSpec`, `ResponsesApiTool`, `FreeformTool`). */
const TOOL_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    function: ["name", "description", "strict", "defer_loading", "parameters", "output_schema"],
    custom: ["name", "description", "defer_loading", "format"],
    namespace: ["name", "description", "tools"],
    tool_search: ["execution", "description", "parameters"],
    web_search: [
      "external_web_access",
      "indexed_web_access",
      "filters",
      "user_location",
      "search_context_size",
      "search_content_types",
    ],
  }).map(([type, fields]) => [type, new Set(["type", ...fields])]),
);
/** Top-level fields Codex sends (`ResponseCreateWsRequest`, `ResponsesApiRequest`, `SearchRequest`). */
const RESPONSES_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "model",
  "stream",
  "service_tier",
  "previous_response_id",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream_options",
  "include",
  "prompt_cache_key",
  "prompt_cache_options",
  "text",
  "generate",
  "client_metadata",
  "access_programs",
]);
const SEARCH_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "model",
  "reasoning",
  "input",
  "commands",
  "settings",
  "max_output_tokens",
]);
/** Fields of Codex's image tool requests (`ImageGenerationRequest`, `GifOptions`). */
const IMAGE_GENERATION_FIELDS: ReadonlySet<string> = new Set([
  "prompt",
  "model",
  "n",
  "quality",
  "size",
  "background",
  "output_format",
  "frame_count",
  "frame_duration_ms",
]);
const IMAGE_EDIT_FIELDS: ReadonlySet<string> = new Set([...IMAGE_GENERATION_FIELDS, "images"]);
/** Codex's image tool sends at most 5 images, each inline. */
const MAX_EDIT_IMAGES = 5;
const INLINE_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;
/** The only WebSocket request Codex sends (`ResponsesWsRequest`). */
const ALLOWED_FRAME_TYPE = "response.create";

export type PayloadVerdict = { forward: string } | { refused: string };

/** The upstream path and query for an allowed request; undefined for everything else. */
export function upstreamTarget(
  method: string,
  pathname: string,
  search: URLSearchParams,
  webSocket: boolean,
): string | undefined {
  if (!pathname.startsWith(`${CLIENT_BASE}/`)) return undefined;
  const path = pathname.slice(CLIENT_BASE.length);
  const allowedQuery = webSocket
    ? method === "GET"
      ? WEBSOCKET_ROUTES.get(path)
      : undefined
    : HTTP_ROUTES.get(`${method} ${path}`);
  if (allowedQuery === undefined) return undefined;
  const query = new URLSearchParams();
  for (const name of allowedQuery) {
    const value = search.get(name);
    if (value !== null) query.set(name, value);
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `${UPSTREAM_BASE}${path}${suffix}`;
}

/**
 * Checks a request body and returns the exact text to forward: the checked parse, re-serialized,
 * so upstream never reads a different version of it (duplicate keys, invalid UTF-8).
 */
export function inspectRequestBody(
  bytes: ArrayBuffer | Uint8Array,
  upstreamPath: string,
): PayloadVerdict {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refused: "payload must be valid UTF-8" };
  }
  const route = upstreamPath.slice(UPSTREAM_BASE.length);
  if (route === "/images/generations" || route === "/images/edits")
    return inspectImageRequest(text, route === "/images/edits");
  return inspect(text, false, route === "/alpha/search" ? SEARCH_FIELDS : RESPONSES_FIELDS);
}

/**
 * Image requests carry a prompt and, for edits, inline images. File references are refused:
 * they name files in the host's ChatGPT account, which a client must not reach.
 */
function inspectImageRequest(text: string, edit: boolean): PayloadVerdict {
  const payload = parseObject(text);
  if (payload === undefined) return { refused: "payload must be a JSON object" };
  const fields = edit ? IMAGE_EDIT_FIELDS : IMAGE_GENERATION_FIELDS;
  const unknown = Object.keys(payload).find((field) => !fields.has(field));
  if (unknown !== undefined) return { refused: `field ${quote(unknown)} is not accepted` };
  if (typeof payload.prompt !== "string") return { refused: "prompt must be a string" };
  if (edit) {
    const { images } = payload;
    if (!Array.isArray(images) || images.length === 0 || images.length > MAX_EDIT_IMAGES)
      return { refused: `images must list 1 to ${MAX_EDIT_IMAGES} images` };
    for (const image of images) {
      if (
        !isRecord(image) ||
        Object.keys(image).length !== 1 ||
        typeof image.image_url !== "string" ||
        !INLINE_IMAGE.test(image.image_url)
      )
        return { refused: "images must be inline data URLs; file references are not available" };
    }
  }
  return { forward: JSON.stringify(payload) };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(text);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** Checks a WebSocket frame and returns the exact text to forward. */
export function inspectFrame(text: string): PayloadVerdict {
  return inspect(text, true, RESPONSES_FIELDS);
}

function inspect(text: string, frame: boolean, fields: ReadonlySet<string>): PayloadVerdict {
  const payload = parseObject(text);
  if (payload === undefined) return { refused: "payload must be a JSON object" };
  if (frame && payload.type !== ALLOWED_FRAME_TYPE)
    return { refused: `only ${ALLOWED_FRAME_TYPE} frames are accepted` };
  if (!frame && "type" in payload) return { refused: 'field "type" is not accepted' };
  const unknown = Object.keys(payload).find((field) => !fields.has(field));
  if (unknown !== undefined) return { refused: `field ${quote(unknown)} is not accepted` };
  const reason = toolsRefusal(payload.tools, 0) ?? toolChoiceRefusal(payload.tool_choice);
  if (reason !== undefined) return { refused: reason };
  if (
    payload.input !== undefined &&
    !Array.isArray(payload.input) &&
    typeof payload.input !== "string"
  )
    return { refused: "input must be a string or an array" };
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (!isRecord(item)) continue;
    if (typeof item.type === "string" && item.type.toLowerCase().startsWith("mcp"))
      return { refused: "hosted MCP items are not available through Shared Login" };
    const itemReason = toolsRefusal(item.tools, 0);
    if (itemReason !== undefined) return { refused: itemReason };
  }
  return { forward: JSON.stringify(payload) };
}

function toolsRefusal(tools: unknown, depth: number): string | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) return "tools must be an array";
  if (depth >= MAX_TOOL_DEPTH) return "tools are nested too deeply";
  for (const tool of tools) {
    const allowed =
      isRecord(tool) && typeof tool.type === "string" ? TOOL_FIELDS.get(tool.type) : undefined;
    if (allowed === undefined)
      return `tool type ${describeType(tool)} is not available through Shared Login`;
    const unknown = Object.keys(tool).find((field) => !allowed.has(field));
    if (unknown !== undefined) return `tool field ${quote(unknown)} is not accepted`;
    const nested = toolsRefusal(tool.tools, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function toolChoiceRefusal(choice: unknown): string | undefined {
  if (choice === undefined || choice === null || typeof choice === "string") return undefined;
  if (isRecord(choice) && typeof choice.type === "string" && TOOL_FIELDS.has(choice.type))
    return undefined;
  return `tool_choice ${describeType(choice)} is not available through Shared Login`;
}

function describeType(value: unknown): string {
  const type = isRecord(value) ? value.type : undefined;
  return typeof type === "string" ? quote(type) : "(missing)";
}

function quote(value: string): string {
  return JSON.stringify(value.slice(0, 40));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

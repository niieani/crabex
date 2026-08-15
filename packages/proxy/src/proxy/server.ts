import { randomUUID } from "node:crypto";

import type {
  CaptureDirection,
  CaptureEncoding,
  CaptureSink,
  CaptureTransport,
} from "../recording/capture.ts";
import { classifyHarness, type HarnessIdentity } from "../context/harness.ts";
import { transformResponseCreate, type ResponseCreatePayload } from "../context/transform.ts";
import type { Transformation, TransformationExecution } from "../context/transformation.ts";
import { CloudflareCookieJar } from "./cloudflare-cookie-jar.ts";
import type { LocalApi } from "../api/local-api.ts";

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const WEBSOCKET_HANDSHAKE_HEADERS = [
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
];

export interface ReverseProxyOptions {
  host?: string;
  port?: number;
  upstreamOrigin: string;
  captureSink: CaptureSink;
  maxRequestBytes?: number;
  now?: () => Date;
  createSessionId?: () => string;
  transformationSource?: TransformationSource;
  project?: string;
  localApi?: LocalApi;
}

export interface TransformationSource {
  get(): Transformation[];
}

export interface RunningProxy {
  origin: string;
  close(): Promise<void>;
}

interface SocketData {
  upstream: WebSocket;
  recorder: EventRecorder;
  client?: Bun.ServerWebSocket<SocketData>;
  clientToUpstream: Promise<void>;
  upstreamToClient: Promise<void>;
  pendingUpstream: MessageEvent[];
  harness: HarnessIdentity;
  project?: string;
  transformationSource: TransformationSource;
}

export async function startReverseProxy(options: ReverseProxyOptions): Promise<RunningProxy> {
  const host = options.host ?? "127.0.0.1";
  const upstreamOrigin = parseUpstreamOrigin(options.upstreamOrigin);
  const recorder = new EventRecorder(
    options.captureSink,
    options.now ?? (() => new Date()),
    options.createSessionId ?? randomUUID,
  );
  const cookies = new CloudflareCookieJar();
  const transformationSource = options.transformationSource ?? { get: () => [] };

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port ?? 8765,
    async fetch(request, bunServer) {
      const localResponse = await options.localApi?.handle(request);
      if (localResponse !== undefined) return localResponse;
      if (isWebSocketUpgrade(request)) {
        return upgradeWebSocket(
          request,
          bunServer,
          upstreamOrigin,
          recorder,
          cookies,
          transformationSource,
          options.project,
        );
      }
      return proxyHttpRequest(
        request,
        upstreamOrigin,
        recorder,
        cookies,
        options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
        transformationSource,
        options.project,
      );
    },
    websocket: {
      data: {} as SocketData,
      idleTimeout: 0,
      maxPayloadLength: DEFAULT_MAX_REQUEST_BYTES,
      perMessageDeflate: true,
      open(client) {
        client.data.client = client;
        for (const event of client.data.pendingUpstream.splice(0)) {
          queueUpstreamMessage(client.data, event);
        }
      },
      message(client, message) {
        const data = client.data;
        const encoding = typeof message === "string" ? "utf8" : "base64";
        data.clientToUpstream = data.clientToUpstream
          .then(async () => {
            const processed = processClientPayload(
              message,
              encoding,
              data.transformationSource.get(),
              data.harness,
              data.project,
            );
            await data.recorder.record("websocket", "client_to_upstream", message, encoding, {
              effectivePayload: processed.effectivePayload,
              transformationExecutions: processed.transformationExecutions,
              harness: data.harness,
              project: data.project,
            });
            if (data.upstream.readyState !== WebSocket.OPEN) {
              throw new Error("upstream websocket is not open");
            }
            data.upstream.send(processed.value);
          })
          .catch(() => closePair(data, 1011, "capture failed"));
      },
      close(client, code, reason) {
        closeUpstream(client.data.upstream, code, reason);
      },
    },
  });

  return {
    origin: server.url.origin,
    close: () => server.stop(true),
  };
}

async function proxyHttpRequest(
  request: Request,
  upstreamOrigin: URL,
  recorder: EventRecorder,
  cookies: CloudflareCookieJar,
  maxRequestBytes: number,
  transformationSource: TransformationSource,
  project: string | undefined,
): Promise<Response> {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maxRequestBytes) throw new RequestTooLarge();
    const body = Buffer.from(await request.arrayBuffer());
    if (body.byteLength > maxRequestBytes) throw new RequestTooLarge();
    const harness = classifyHarness(request.headers);
    const processed = processClientPayload(
      body,
      "utf8",
      transformationSource.get(),
      harness,
      project,
    );
    await recorder.record("http", "client_to_upstream", body, "utf8", {
      effectivePayload: processed.effectivePayload,
      transformationExecutions: processed.transformationExecutions,
      harness,
      project,
    });

    const headers = forwardedHeaders(request.headers, cookies.header());
    const response = await fetch(targetUrl(upstreamOrigin, request.url), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : processed.value,
      redirect: "manual",
      decompress: false,
    });
    cookies.capture(response.headers);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: downstreamHeaders(response.headers),
    });
  } catch (error) {
    return new Response(error instanceof CaptureFailure ? "capture failed" : errorMessage(error), {
      status: error instanceof RequestTooLarge ? 413 : 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function upgradeWebSocket(
  request: Request,
  server: Bun.Server<SocketData>,
  upstreamOrigin: URL,
  recorder: EventRecorder,
  cookies: CloudflareCookieJar,
  transformationSource: TransformationSource,
  project: string | undefined,
): Promise<Response | undefined> {
  try {
    const target = targetUrl(upstreamOrigin, request.url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const upstream = await connectWebSocket(
      target,
      forwardedWebSocketHeaders(request.headers, cookies.header()),
      requestedProtocols(request.headers.get("sec-websocket-protocol")),
    );
    const data: SocketData = {
      upstream,
      recorder,
      clientToUpstream: Promise.resolve(),
      upstreamToClient: Promise.resolve(),
      pendingUpstream: [],
      harness: classifyHarness(request.headers),
      ...(project === undefined ? {} : { project }),
      transformationSource,
    };
    upstream.binaryType = "nodebuffer";
    upstream.addEventListener("message", (event) => {
      if (data.client === undefined) data.pendingUpstream.push(event);
      else queueUpstreamMessage(data, event);
    });
    upstream.addEventListener("close", (event) => {
      if (data.client !== undefined) closeClient(data.client, event.code, event.reason);
    });
    upstream.addEventListener("error", () => closePair(data, 1011, "upstream error"));

    if (server.upgrade(request, { data })) return undefined;
    upstream.close(1011, "client upgrade failed");
    return new Response("WebSocket upgrade failed", { status: 500 });
  } catch (error) {
    return new Response(errorMessage(error), {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

function queueUpstreamMessage(data: SocketData, event: MessageEvent): void {
  data.upstreamToClient = data.upstreamToClient
    .then(async () => {
      const message = await websocketMessage(event.data);
      const encoding = typeof message === "string" ? "utf8" : "base64";
      await data.recorder.record("websocket", "upstream_to_client", message, encoding, {
        harness: data.harness,
        project: data.project,
      });
      const client = data.client;
      if (client === undefined || client.readyState !== WebSocket.OPEN) {
        throw new Error("client websocket is not open");
      }
      if (client.send(message) === 0) throw new Error("client websocket send failed");
    })
    .catch(() => closePair(data, 1011, "capture failed"));
}

function connectWebSocket(
  url: URL,
  headers: Record<string, string>,
  protocols: string[],
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      protocols,
      perMessageDeflate: true,
    });
    const onOpen = () => {
      socket.removeEventListener("error", onError);
      resolve(socket);
    };
    const onError = () => {
      socket.removeEventListener("open", onOpen);
      reject(new Error("upstream WebSocket connection failed"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

class EventRecorder {
  #sequence = 0;
  readonly #sessionId: string;
  readonly #sink: CaptureSink;
  readonly #now: () => Date;

  constructor(sink: CaptureSink, now: () => Date, createSessionId: () => string) {
    this.#sink = sink;
    this.#now = now;
    this.#sessionId = createSessionId();
  }

  async record(
    transport: CaptureTransport,
    direction: CaptureDirection,
    value: string | ArrayBuffer | Uint8Array,
    encoding: CaptureEncoding,
    metadata: {
      effectivePayload?: string;
      transformationExecutions?: TransformationExecution[];
      harness?: HarnessIdentity;
      project?: string;
    } = {},
  ): Promise<void> {
    const payload =
      typeof value === "string"
        ? value
        : bufferFrom(value).toString(encoding === "base64" ? "base64" : "utf8");
    try {
      await this.#sink.record({
        sessionId: this.#sessionId,
        sequence: ++this.#sequence,
        timestamp: this.#now().toISOString(),
        transport,
        direction,
        encoding,
        payload,
        ...(metadata.effectivePayload === undefined
          ? {}
          : { effectivePayload: metadata.effectivePayload }),
        ...(metadata.transformationExecutions === undefined
          ? {}
          : { transformationExecutions: metadata.transformationExecutions }),
        ...(metadata.harness === undefined ? {} : { harness: metadata.harness }),
        ...(metadata.project === undefined ? {} : { project: metadata.project }),
      });
    } catch (error) {
      throw new CaptureFailure(error);
    }
  }
}

function processClientPayload(
  value: string | ArrayBuffer | Uint8Array,
  encoding: CaptureEncoding,
  transformations: Transformation[],
  harness: HarnessIdentity,
  project: string | undefined,
): {
  value: string | ArrayBuffer | Uint8Array;
  effectivePayload?: string;
  transformationExecutions?: TransformationExecution[];
} {
  if (encoding !== "utf8" || transformations.length === 0) return { value };
  const original = typeof value === "string" ? value : bufferFrom(value).toString("utf8");
  let payload: ResponseCreatePayload;
  try {
    payload = JSON.parse(original) as ResponseCreatePayload;
  } catch {
    return { value };
  }
  if (payload.type !== "response.create") return { value };
  const result = transformResponseCreate(payload, transformations, { harness, project });
  const effectivePayload = JSON.stringify(result.payload);
  const changed = effectivePayload !== original;
  return {
    value: changed ? effectivePayload : value,
    ...(changed ? { effectivePayload } : {}),
    transformationExecutions: result.executions,
  };
}

class CaptureFailure extends Error {
  constructor(cause: unknown) {
    super("capture failed", { cause });
  }
}

class RequestTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function forwardedHeaders(
  incoming: Headers,
  cloudflareCookie: string | undefined,
): Record<string, string> {
  const headers = Object.fromEntries(incoming);
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  if (cloudflareCookie !== undefined) {
    headers.cookie = mergeCookies(incoming.get("cookie"), cloudflareCookie);
  }
  return headers;
}

function forwardedWebSocketHeaders(
  incoming: Headers,
  cloudflareCookie: string | undefined,
): Record<string, string> {
  const headers = forwardedHeaders(incoming, cloudflareCookie);
  for (const name of WEBSOCKET_HANDSHAKE_HEADERS) delete headers[name];
  return headers;
}

function downstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of [...HOP_BY_HOP_HEADERS, "set-cookie"]) headers.delete(name);
  return headers;
}

function targetUrl(upstreamOrigin: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
}

function parseUpstreamOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported upstream protocol: ${url.protocol}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("upstreamOrigin must contain only scheme and authority");
  }
  return url;
}

function requestedProtocols(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean)
    : [];
}

async function websocketMessage(value: unknown): Promise<string | Uint8Array> {
  if (typeof value === "string") return value;
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`unsupported WebSocket message: ${typeof value}`);
}

function closePair(data: SocketData, code: number, reason: string): void {
  if (data.client !== undefined) closeClient(data.client, code, reason);
  closeUpstream(data.upstream, code, reason);
}

function closeClient(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
}

function closeUpstream(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
}

function mergeCookies(existing: string | null, cloudflare: string): string {
  return existing === null || existing === "" ? cloudflare : `${existing}; ${cloudflare}`;
}

function bufferFrom(value: ArrayBuffer | Uint8Array): Buffer {
  return value instanceof ArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { randomUUID } from "node:crypto";

import type { CaptureRouting, CaptureSink } from "../recording/capture.ts";
import { classifyHarness, type HarnessIdentity } from "../context/harness.ts";
import type { Transformation } from "../context/transformation.ts";
import type { ConfigBundleOverride } from "../config/config-bundle-store.ts";
import type { UpstreamCacheStore } from "../config/upstream-cache.ts";
import { transformModelDefinitions } from "../context/transform.ts";
import {
  decodeBody,
  type ModelDefinition,
  transformModelsResponse,
} from "../routing/model-list.ts";
import { modelsFixture } from "../routing/models-fixture.ts";
import {
  authorizationFor,
  inspectResponseModel,
  modelRouteFor,
  responseTargetUrl,
  routedHeaders,
  RouteUnavailable,
  type ModelAdjustment,
  type ModelRoute,
} from "../routing/model-routes.ts";
import { fetchWithFailover, TargetBreakers } from "../routing/failover.ts";
import {
  isConfigBundleRequest,
  isModelsRequest,
  isResponsesPath,
  isResponsesRequest,
} from "../routing/paths.ts";
import { CloudflareCookieJar } from "./cloudflare-cookie-jar.ts";
import { CaptureFailure, EventRecorder, processClientPayload } from "./event-recorder.ts";
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
  modelRouteSource?: ModelRouteSource;
  configBundleSource?: ConfigBundleSource;
  upstreamCache?: UpstreamCacheStore;
  /** Baked-in model catalog; defaults to the packaged fixture. */
  fixtureModels?: ModelDefinition[];
  /** Shared circuit-breaker registry for route targets; defaults to a fresh one. */
  breakers?: TargetBreakers;
  project?: string;
  localApi?: LocalApi;
}

export interface TransformationSource {
  get(): Transformation[];
}

export interface ModelRouteSource {
  get(): { routes: ModelRoute[]; adjustments: ModelAdjustment[]; fixturePins: string[] };
}

export interface ConfigBundleSource {
  get(): ConfigBundleOverride;
}

export interface RunningProxy {
  origin: string;
  close(): Promise<void>;
}

interface SocketData {
  upstream?: WebSocket;
  recorder: EventRecorder;
  client?: Bun.ServerWebSocket<SocketData>;
  clientToUpstream: Promise<void>;
  upstreamToClient: Promise<void>;
  pendingUpstream: MessageEvent[];
  harness: HarnessIdentity;
  project?: string;
  transformationSource: TransformationSource;
  connectUpstream?: (firstValue: string | ArrayBuffer | Uint8Array) => Promise<{
    value: string | ArrayBuffer | Uint8Array;
    routing?: CaptureRouting;
  }>;
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
  const modelRouteSource = options.modelRouteSource ?? {
    get: () => ({ routes: [], adjustments: [], fixturePins: [] }),
  };
  const fixtureModels = options.fixtureModels ?? modelsFixture();
  const breakers = options.breakers ?? new TargetBreakers();
  const configBundleSource = options.configBundleSource;
  const upstreamCache = options.upstreamCache;
  let lastBundleObservation = 0;

  // While the bundle override answers locally, refresh the observed upstream
  // bundle in the background (throttled) so the original stays inspectable.
  const observeBundleUpstream = (request: Request): void => {
    if (upstreamCache === undefined) return;
    const nowMs = Date.now();
    if (nowMs - lastBundleObservation < 60_000) return;
    lastBundleObservation = nowMs;
    void fetch(targetUrl(upstreamOrigin, request.url), {
      headers: forwardedHeaders(request.headers, cookies.header()),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const encoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
        const body: unknown = JSON.parse(
          new TextDecoder().decode(await decodeBody(bytes, encoding)),
        );
        await upstreamCache.observe("configBundle", body);
      })
      .catch(() => {
        // observation is best-effort
      });
  };

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port ?? 8765,
    async fetch(request, bunServer) {
      const localResponse = await options.localApi?.handle(request);
      if (localResponse !== undefined) return localResponse;
      const requestPath = new URL(request.url).pathname;
      const bundleOverride = configBundleSource?.get();
      if (bundleOverride?.enabled === true && isConfigBundleRequest(requestPath)) {
        try {
          await recorder.record("http", "client_to_upstream", "", "utf8", {
            harness: classifyHarness(request.headers),
            project: options.project,
            routing: { action: "bundle-override" },
          });
        } catch {
          return new Response("capture failed", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        observeBundleUpstream(request);
        return Response.json(bundleOverride.bundle);
      }
      if (isWebSocketUpgrade(request)) {
        return upgradeWebSocket(
          request,
          bunServer,
          upstreamOrigin,
          recorder,
          cookies,
          transformationSource,
          modelRouteSource,
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
        modelRouteSource,
        upstreamCache,
        options.project,
        fixtureModels,
        breakers,
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
            let outbound = processed.value;
            let routing: CaptureRouting | undefined;
            if (data.upstream === undefined) {
              if (data.connectUpstream === undefined) {
                throw new Error("upstream websocket is not open");
              }
              const connected = await data.connectUpstream(processed.value);
              outbound = connected.value;
              routing = connected.routing;
            }
            await data.recorder.record("websocket", "client_to_upstream", message, encoding, {
              effectivePayload: processed.effectivePayload,
              requestSummary: processed.requestSummary,
              transformationChanged: processed.transformationChanged,
              transformationExecutions: processed.transformationExecutions,
              harness: data.harness,
              project: data.project,
              routing,
            });
            const upstream = data.upstream;
            if (upstream === undefined || upstream.readyState !== WebSocket.OPEN) {
              throw new Error("upstream websocket is not open");
            }
            upstream.send(outbound);
          })
          .catch(() => closePair(data, 1011, "capture failed"));
      },
      close(client, code, reason) {
        if (client.data.upstream !== undefined) closeUpstream(client.data.upstream, code, reason);
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
  modelRouteSource: ModelRouteSource,
  upstreamCache: UpstreamCacheStore | undefined,
  project: string | undefined,
  fixtureModels: ModelDefinition[],
  breakers: TargetBreakers,
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

    const requestUrl = new URL(request.url);
    const routeSet = modelRouteSource.get();
    const routes = routeSet.routes;
    const target = targetUrl(upstreamOrigin, request.url);
    let headers = forwardedHeaders(request.headers, cookies.header());
    const outbound = processed.value;
    let routing: CaptureRouting | undefined;
    const routedRequest = (() => {
      if (routes.length === 0 || !isResponsesRequest(request.method, requestUrl.pathname)) {
        return undefined;
      }
      const inspected = inspectResponseModel(processed.value);
      const route = inspected === undefined ? undefined : modelRouteFor(routes, inspected.model);
      return inspected === undefined || route === undefined ? undefined : { inspected, route };
    })();
    if (routedRequest !== undefined) {
      const { inspected, route } = routedRequest;
      headers = routedHeaders(headers, authorizationFor(route, process.env));
      routing = {
        action: "routed",
        routeSlugs: [route.model.slug],
        upstream: route.upstream.origin,
        requestedModel: inspected.model,
        upstreamModel: route.targets[0]?.upstreamModel ?? route.model.slug,
      };
    } else if (routes.length > 0 && isModelsRequest(request.method, requestUrl.pathname)) {
      routing = {
        action: "models-advertised",
        routeSlugs: routes.map((route) => route.model.slug),
      };
    }

    // Non-routed requests record before touching the upstream so a capture
    // failure fails closed; routed requests record after the attempt loop so
    // the event carries the attempt trail.
    if (routedRequest === undefined) {
      await recorder.record("http", "client_to_upstream", body, "utf8", {
        effectivePayload: processed.effectivePayload,
        requestSummary: processed.requestSummary,
        transformationChanged: processed.transformationChanged,
        transformationExecutions: processed.transformationExecutions,
        harness,
        project,
        routing,
      });
    }

    const response =
      routedRequest === undefined
        ? await fetch(target, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD" ? undefined : outbound,
            redirect: "manual",
            decompress: false,
          })
        : await fetchWithFailover({
            route: routedRequest.route,
            breakers,
            requestFor: (routeTarget) => ({
              url: responseTargetUrl(routedRequest.route, requestUrl.search),
              init: {
                method: request.method,
                headers,
                body: JSON.stringify({
                  ...routedRequest.inspected.payload,
                  model: routeTarget.upstreamModel ?? routedRequest.route.model.slug,
                }),
                redirect: "manual",
                decompress: false,
              },
            }),
          }).then((result) => {
            const base: CaptureRouting = routing ?? { action: "routed" };
            routing = {
              ...base,
              ...(result.servedBy === undefined ? {} : { upstreamModel: result.servedBy }),
              attempts: result.attempts,
            };
            return result.response;
          });
    cookies.capture(response.headers);

    if (routedRequest !== undefined) {
      await recorder.record("http", "client_to_upstream", body, "utf8", {
        effectivePayload: processed.effectivePayload,
        requestSummary: processed.requestSummary,
        transformationChanged: processed.transformationChanged,
        transformationExecutions: processed.transformationExecutions,
        harness,
        project,
        routing,
      });
    }

    const downstream = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: downstreamHeaders(response.headers),
    });
    if (isModelsRequest(request.method, requestUrl.pathname)) {
      return await transformModelsResponse(downstream, {
        routes,
        adjustments: routeSet.adjustments,
        fixture: { models: fixtureModels, pins: routeSet.fixturePins },
        observe:
          upstreamCache === undefined ? undefined : (body) => upstreamCache.observe("models", body),
        applyTransformations: (models) =>
          transformModelDefinitions(models, transformationSource.get(), {
            harness,
            project,
          }).models,
      });
    }
    if (isConfigBundleRequest(requestUrl.pathname)) {
      return await observePassthrough(downstream, upstreamCache);
    }
    return downstream;
  } catch (error) {
    return new Response(error instanceof CaptureFailure ? "capture failed" : errorMessage(error), {
      status:
        error instanceof RequestTooLarge ? 413 : error instanceof RouteUnavailable ? 502 : 500,
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
  modelRouteSource: ModelRouteSource,
  project: string | undefined,
): Promise<Response | undefined> {
  try {
    const requestUrl = new URL(request.url);
    const routes = modelRouteSource.get().routes.filter((route) => route.enabled);
    const lazyRouting = routes.length > 0 && isResponsesPath(requestUrl.pathname);
    const baseHeaders = forwardedWebSocketHeaders(request.headers, cookies.header());
    const protocols = requestedProtocols(request.headers.get("sec-websocket-protocol"));
    const data: SocketData = {
      recorder,
      clientToUpstream: Promise.resolve(),
      upstreamToClient: Promise.resolve(),
      pendingUpstream: [],
      harness: classifyHarness(request.headers),
      ...(project === undefined ? {} : { project }),
      transformationSource,
    };

    if (lazyRouting) {
      const defaultTarget = webSocketTarget(targetUrl(upstreamOrigin, request.url));
      data.connectUpstream = async (firstValue) => {
        const inspected = inspectResponseModel(firstValue);
        const route = inspected === undefined ? undefined : modelRouteFor(routes, inspected.model);
        const target =
          route === undefined
            ? defaultTarget
            : webSocketTarget(responseTargetUrl(route, requestUrl.search));
        const headers =
          route === undefined
            ? baseHeaders
            : routedHeaders(baseHeaders, authorizationFor(route, process.env));
        const upstream = await connectWebSocket(target, headers, protocols);
        attachUpstream(data, upstream);
        data.upstream = upstream;
        if (route === undefined || inspected === undefined) return { value: firstValue };
        return {
          value: JSON.stringify({
            ...inspected.payload,
            model: route.upstreamModel ?? route.model.slug,
          }),
          routing: {
            action: "routed" as const,
            routeSlugs: [route.model.slug],
            upstream: route.upstream.origin,
            requestedModel: inspected.model,
            upstreamModel: route.upstreamModel ?? route.model.slug,
          },
        };
      };
      if (server.upgrade(request, { data })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const upstream = await connectWebSocket(
      webSocketTarget(targetUrl(upstreamOrigin, request.url)),
      baseHeaders,
      protocols,
    );
    data.upstream = upstream;
    attachUpstream(data, upstream);

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

function attachUpstream(data: SocketData, upstream: WebSocket): void {
  upstream.binaryType = "nodebuffer";
  upstream.addEventListener("message", (event) => {
    if (data.client === undefined) data.pendingUpstream.push(event);
    else queueUpstreamMessage(data, event);
  });
  upstream.addEventListener("close", (event) => {
    if (data.client !== undefined) closeClient(data.client, event.code, event.reason);
  });
  upstream.addEventListener("error", () => closePair(data, 1011, "upstream error"));
}

function webSocketTarget(target: URL): URL {
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target;
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

async function observePassthrough(
  response: Response,
  upstreamCache: UpstreamCacheStore | undefined,
): Promise<Response> {
  if (!response.ok || upstreamCache === undefined) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    const encoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    const body: unknown = JSON.parse(new TextDecoder().decode(await decodeBody(bytes, encoding)));
    await upstreamCache.observe("configBundle", body);
  } catch {
    // observation is best-effort; pass the response through untouched
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
  if (data.upstream !== undefined) closeUpstream(data.upstream, code, reason);
}

function closeClient(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const valid = sanitizeCloseCode(code);
  if (valid === undefined) socket.close();
  else socket.close(valid, reason);
}

function closeUpstream(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const valid = sanitizeCloseCode(code);
  if (valid === undefined) socket.close();
  else socket.close(valid, reason);
}

/**
 * Reserved close codes (1004-1006, 1015+) cannot be sent in a close frame;
 * echoing an upstream's abnormal 1006 would throw. Omit the code instead.
 */
export function sanitizeCloseCode(code: number): number | undefined {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
    ? code
    : undefined;
}

function mergeCookies(existing: string | null, cloudflare: string): string {
  return existing === null || existing === "" ? cloudflare : `${existing}; ${cloudflare}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

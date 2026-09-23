import { anthropicFetch } from "./anthropic/adapter.ts";
import { randomBytes, randomUUID } from "node:crypto";

import type { CaptureRouting, CaptureSink, CaptureUpstreamOrigin } from "../recording/capture.ts";
import type { StatsStore } from "../recording/stats-store.ts";
import { classifyHarness, type HarnessIdentity } from "../context/harness.ts";
import type { Transformation } from "../context/transformation.ts";
import type { ConfigBundleOverride } from "../config/config-bundle-store.ts";
import type { ProxyConfigStore } from "../config/proxy-config-store.ts";
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
import { fetchWithFailover, TargetBreakers, type FailoverEvent } from "../routing/failover.ts";
import {
  applyRouteToolPolicy,
  ToolPolicyError,
  warnOmittedToolTypes,
} from "../routing/tool-policy.ts";
import {
  httpPayloadFor,
  parseSseEvents,
  rewriteBridgedEvent,
  SseEventScanner,
  warmupCompletionEvents,
  wrappedErrorEvent,
} from "./responses-bridge.ts";
import {
  createResponsesToolBridge,
  translateResponsesStream,
  type ResponsesToolBridge,
} from "./responses-tool-bridge.ts";
import { LoadedToolRegistry } from "./tool-search.ts";
import {
  completedStoredResponse,
  continuationSessionKey,
  prepareStoredRequest,
  StoredResponseRegistry,
  storedResponseKey,
  type PreparedStoredRequest,
  type StoredResponseState,
} from "./stored-response-continuation.ts";
import {
  isConfigBundleRequest,
  isModelsRequest,
  isResponsesPath,
  isResponsesRequest,
} from "../routing/paths.ts";
import { CloudflareCookieJar } from "./cloudflare-cookie-jar.ts";
import { AppsAuthRelay } from "./apps-auth-relay.ts";
import { observePayload } from "../recording/payload-observation.ts";
import { CaptureFailure, EventRecorder, processClientPayload } from "./event-recorder.ts";
import type { LocalApi } from "../api/local-api.ts";
import { LiveRequestStore } from "../requests/live-request-store.ts";

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
  /** Persistent 32-byte key for encrypted Anthropic reasoning and compaction replay. */
  anthropicKey?: Uint8Array;
  /** Reuse observed ChatGPT credentials for unauthenticated Apps MCP requests. Single account only. */
  appsAuthRelay?: boolean;
  proxyConfigSource?: Pick<ProxyConfigStore, "get" | "subscribe">;
  host?: string;
  tls?: { cert: string; key: string };
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
  /** Persisted telemetry counters fed by the event recorder. */
  stats?: StatsStore;
  project?: string;
  localApi?: LocalApi;
  webUi?: (request: Request) => Promise<Response | undefined>;
  liveRequests?: LiveRequestStore;
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

interface BridgeContext {
  routes: readonly ModelRoute[];
  search: string;
  baseHeaders: Record<string, string>;
  breakers: TargetBreakers;
}

interface SocketData {
  anthropicKey: Uint8Array;
  bridgeAbort?: AbortController;
  upstream?: WebSocket;
  recorder: EventRecorder;
  client?: Bun.ServerWebSocket<SocketData>;
  clientToUpstream: Promise<void>;
  upstreamToClient: Promise<void>;
  pendingUpstream: MessageEvent[];
  harness: HarnessIdentity;
  project?: string;
  transformationSource: TransformationSource;
  bridge?: BridgeContext;
  connectedRoute?: ModelRoute;
  connectUpstream?: (firstValue: string | ArrayBuffer | Uint8Array) => Promise<{
    value: string | ArrayBuffer | Uint8Array;
    routing?: CaptureRouting;
  }>;
  /** Last routed request on this socket; used to attribute completed usage. */
  lastRouting?: CaptureRouting;
  /** Origin of the live ChatGPT/gateway WebSocket peer. */
  upstreamOrigin?: CaptureUpstreamOrigin;
  liveRequests: LiveRequestStore;
  activeRequestId?: string;
  continuationSession?: string;
  storedResponses: StoredResponseRegistry;
  storedResponse?: StoredResponseState;
  loadedTools: LoadedToolRegistry;
}

export async function startReverseProxy(options: ReverseProxyOptions): Promise<RunningProxy> {
  const anthropicKey = options.anthropicKey ?? randomBytes(32);
  const host = options.host ?? "127.0.0.1";
  const upstreamOrigin = parseUpstreamOrigin(options.upstreamOrigin);
  let appsAuthRelay: AppsAuthRelay | undefined;
  const syncAppsAuthRelay = () => {
    const enabled = options.appsAuthRelay ?? options.proxyConfigSource?.get().appsAuthRelay ?? true;
    if (enabled && !["127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error(
        "Apps authentication relay requires a loopback listener; disable it in config or with --no-apps-auth-relay",
      );
    }
    if (enabled) appsAuthRelay ??= new AppsAuthRelay();
    else {
      appsAuthRelay?.close();
      appsAuthRelay = undefined;
    }
  };
  syncAppsAuthRelay();
  const unsubscribeProxyConfig = options.proxyConfigSource?.subscribe(syncAppsAuthRelay);
  const recorder = new EventRecorder(
    options.captureSink,
    options.now ?? (() => new Date()),
    options.createSessionId ?? randomUUID,
    options.stats,
  );
  const cookies = new CloudflareCookieJar();
  const transformationSource = options.transformationSource ?? { get: () => [] };
  const modelRouteSource = options.modelRouteSource ?? {
    get: () => ({ routes: [], adjustments: [], fixturePins: [] }),
  };
  const fixtureModels = options.fixtureModels ?? modelsFixture();
  const breakers = options.breakers ?? new TargetBreakers();
  const liveRequests = options.liveRequests ?? new LiveRequestStore();
  const storedResponses = new StoredResponseRegistry();
  const loadedTools = new LoadedToolRegistry();
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
    tls: options.tls,
    port: options.port ?? 8765,
    async fetch(request, bunServer) {
      const localResponse = await options.localApi?.handle(request);
      if (localResponse !== undefined) return localResponse;
      const webResponse = await options.webUi?.(request);
      if (webResponse !== undefined) return webResponse;
      // Directory lookups can take tens of seconds before returning headers,
      // and MCP/SSE streams can pause. Do not let Bun's HTTP idle timer reset
      // the downstream socket while the upstream request is still running.
      bunServer.timeout(request, 0);
      appsAuthRelay?.observe(request);
      if (appsAuthRelay !== undefined) {
        const authenticated = await appsAuthRelay.authenticate(request);
        if (authenticated instanceof Response) return authenticated;
        request = authenticated;
      }
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
          breakers,
          liveRequests,
          storedResponses,
          loadedTools,
          anthropicKey,
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
        liveRequests,
        storedResponses,
        loadedTools,
        anthropicKey,
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
        if (data.bridgeAbort && typeof message === "string") {
          try {
            if (JSON.parse(message).type === "response.cancel") {
              data.bridgeAbort.abort();
              return;
            }
          } catch {
            /* ordinary frame */
          }
        }
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
            let captureEffectivePayload = processed.effectivePayload;
            let omittedTypes: string[] = [];
            const bridged = matchBridgeRoute(data.bridge, processed.value);
            if (bridged !== undefined) {
              try {
                await runBridgedCreate(
                  data,
                  bridged.route,
                  bridged.inspected,
                  message,
                  encoding,
                  processed,
                );
              } catch (error) {
                if (!data.bridgeAbort?.signal.aborted) throw error;
                if (data.activeRequestId)
                  data.liveRequests.finish(data.activeRequestId, {
                    state: "failed",
                    detail: "Request cancelled",
                  });
                data.bridgeAbort = undefined;
                if (client.readyState === WebSocket.OPEN)
                  client.send(wrappedErrorEvent(499, "Request cancelled"));
              }
              return;
            }
            const liveInspected = inspectResponseModel(processed.value);
            if (liveInspected !== undefined) {
              const route =
                data.bridge === undefined
                  ? undefined
                  : modelRouteFor(data.bridge.routes, liveInspected.model);
              data.activeRequestId = data.liveRequests.start({
                transport: "websocket",
                requestedModel: liveInspected.model,
                ...(route === undefined ? {} : { routeSlug: route.model.slug }),
                upstream:
                  route === undefined
                    ? (data.upstreamOrigin?.url ?? "ChatGPT WebSocket upstream")
                    : responseTargetUrl(route, data.bridge?.search ?? "").toString(),
                ...(route === undefined
                  ? {}
                  : { targetModel: route.upstreamModel ?? route.model.slug }),
              });
              data.liveRequests.update(data.activeRequestId, { state: "connecting" });
              const policyRoute = data.connectedRoute ?? route;
              if (policyRoute !== undefined) {
                const policy = applyRouteToolPolicy(policyRoute, liveInspected.payload);
                omittedTypes = policy.omittedTypes;
                noteToolOmissions(
                  policyRoute,
                  omittedTypes,
                  data.liveRequests,
                  data.activeRequestId,
                );
                if (omittedTypes.length > 0) {
                  outbound = JSON.stringify(policy.payload);
                  captureEffectivePayload = outbound;
                  routing = {
                    action: "routed",
                    routeSlugs: [policyRoute.model.slug],
                    upstream: policyRoute.upstream.origin,
                    requestedModel: liveInspected.model,
                    upstreamModel: policyRoute.upstreamModel ?? policyRoute.model.slug,
                    omittedToolTypes: omittedTypes,
                  };
                }
              }
            }
            if (data.upstream === undefined) {
              if (data.connectUpstream === undefined) {
                throw new Error("upstream websocket is not open");
              }
              const connected = await data.connectUpstream(outbound);
              outbound = connected.value;
              routing =
                connected.routing === undefined
                  ? routing
                  : {
                      ...connected.routing,
                      ...(omittedTypes.length === 0 ? {} : { omittedToolTypes: omittedTypes }),
                    };
            }
            if (routing !== undefined) data.lastRouting = routing;
            await data.recorder.record("websocket", "client_to_upstream", message, encoding, {
              effectivePayload: captureEffectivePayload,
              requestSummary: processed.requestSummary,
              transformationChanged: processed.transformationChanged,
              transformationExecutions: processed.transformationExecutions,
              harness: data.harness,
              project: data.project,
              routing,
              ...(data.upstreamOrigin === undefined ? {} : { origin: data.upstreamOrigin }),
            });
            const upstream = data.upstream;
            if (upstream === undefined || upstream.readyState !== WebSocket.OPEN) {
              throw new Error("upstream websocket is not open");
            }
            upstream.send(outbound);
          })
          .catch((error) => {
            if (error instanceof ToolPolicyError) {
              if (data.activeRequestId !== undefined) {
                data.liveRequests.finish(data.activeRequestId, {
                  state: "failed",
                  status: 400,
                  detail: error.message,
                });
              }
              if (client.readyState === WebSocket.OPEN) {
                client.send(wrappedErrorEvent(400, error.message));
              }
              return;
            }
            closePair(data, 1011, "capture failed");
          });
      },
      close(client, code, reason) {
        client.data.bridgeAbort?.abort();
        if (client.data.upstream !== undefined) closeUpstream(client.data.upstream, code, reason);
      },
    },
  });

  return {
    origin: server.url.origin,
    close: () => {
      unsubscribeProxyConfig?.();
      appsAuthRelay?.close();
      return server.stop(true);
    },
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
  liveRequests: LiveRequestStore,
  storedResponses: StoredResponseRegistry,
  loadedTools: LoadedToolRegistry,
  anthropicKey: Uint8Array,
): Promise<Response> {
  let liveRequestId: string | undefined;
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maxRequestBytes) throw new RequestTooLarge();
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.byteLength > maxRequestBytes) throw new RequestTooLarge();
    const contentEncoding = request.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    const body = Buffer.from(await decodeBody(rawBody, contentEncoding));
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
    if (contentEncoding !== "identity" && contentEncoding.length > 0) {
      delete headers["content-encoding"];
      delete headers["content-length"];
    }
    const outbound = processed.value;
    let routing: CaptureRouting | undefined;
    let routedPayload: Record<string, unknown> | undefined;
    let translatedPayload: Record<string, unknown> | undefined;
    let toolBridge: ResponsesToolBridge | undefined;
    let captureEffectivePayload = processed.effectivePayload;
    let preparedStoredRequest: PreparedStoredRequest | undefined;
    let responseStateKey: string | undefined;
    const routedRequest = (() => {
      if (routes.length === 0 || !isResponsesRequest(request.method, requestUrl.pathname)) {
        return undefined;
      }
      const inspected = inspectResponseModel(processed.value);
      const route = inspected === undefined ? undefined : modelRouteFor(routes, inspected.model);
      return inspected === undefined || route === undefined ? undefined : { inspected, route };
    })();
    if (isResponsesRequest(request.method, requestUrl.pathname)) {
      const inspected = inspectResponseModel(processed.value);
      const route = routedRequest?.route;
      liveRequestId = liveRequests.start({
        transport: "http",
        ...(inspected === undefined ? {} : { requestedModel: inspected.model }),
        ...(route === undefined ? {} : { routeSlug: route.model.slug }),
        upstream:
          route === undefined
            ? target.toString()
            : responseTargetUrl(route, requestUrl.search).toString(),
        ...(route?.targets[0]?.upstreamModel === undefined
          ? {}
          : { targetModel: route.targets[0].upstreamModel }),
      });
    }
    if (routedRequest !== undefined) {
      const { inspected, route } = routedRequest;
      const policy = applyRouteToolPolicy(route, inspected.payload);
      noteToolOmissions(route, policy.omittedTypes, liveRequests, liveRequestId);
      if (policy.omittedTypes.length > 0) {
        captureEffectivePayload = JSON.stringify(policy.payload);
      }
      const authorization = authorizationFor(route, process.env);
      headers = routedHeaders(headers, authorization);
      routedPayload = httpPayloadFor(policy.payload, {
        forwardAccessPrograms: route.forwardAccessPrograms,
        storeResponses: route.bridgeResponseState === "stored",
      });
      const scopedKey = storedResponseKey(
        continuationSessionKey(request.headers),
        route.model.slug,
        responseTargetUrl(route, requestUrl.search).toString(),
        route.targets[0]?.upstreamModel ?? route.model.slug,
        authorization,
      );
      if (route.bridgeResponseState === "stored") {
        responseStateKey = scopedKey;
        preparedStoredRequest = prepareStoredRequest(
          routedPayload,
          route.model.slug,
          storedResponses.get(responseStateKey),
        );
      }
      const requestPayload = preparedStoredRequest?.payload ?? routedPayload;
      const searchPayload =
        route.toolPolicy.tool_search === "translate"
          ? loadedTools.prepare(route.model.slug, scopedKey, routedPayload, requestPayload)
          : requestPayload;
      toolBridge = createResponsesToolBridge(route, searchPayload.tools);
      translatedPayload = toolBridge?.request(searchPayload) ?? searchPayload;
      if (toolBridge !== undefined || searchPayload !== requestPayload)
        captureEffectivePayload = JSON.stringify(translatedPayload);
      routing = {
        action: "routed",
        routeSlugs: [route.model.slug],
        upstream: route.upstream.origin,
        requestedModel: inspected.model,
        upstreamModel: route.targets[0]?.upstreamModel ?? route.model.slug,
        ...(policy.omittedTypes.length === 0 ? {} : { omittedToolTypes: policy.omittedTypes }),
      };
    } else if (routes.length > 0 && isModelsRequest(request.method, requestUrl.pathname)) {
      routing = {
        action: "models-advertised",
        routeSlugs: routes.map((route) => route.model.slug),
      };
    }

    const origin: CaptureUpstreamOrigin =
      routedRequest === undefined
        ? { kind: "chatgpt-http", url: target.toString() }
        : {
            kind: "gateway-http",
            url: responseTargetUrl(routedRequest.route, requestUrl.search).toString(),
          };

    // Non-routed requests record before touching the upstream so a capture
    // failure fails closed; routed requests record after the attempt loop so
    // the event carries the attempt trail.
    if (routedRequest === undefined) {
      await recorder.record("http", "client_to_upstream", body, "utf8", {
        effectivePayload: captureEffectivePayload,
        requestSummary: processed.requestSummary,
        transformationChanged: processed.transformationChanged,
        transformationExecutions: processed.transformationExecutions,
        harness,
        project,
        routing,
        origin,
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
            signal: request.signal,
            fetchImpl:
              routedRequest.route.api === "anthropic-messages"
                ? anthropicFetch(
                    routedRequest.route,
                    anthropicKey,
                    request.signal,
                    requestUrl.pathname.endsWith("/compact"),
                  )
                : undefined,
            breakers,
            onEvent:
              liveRequestId === undefined
                ? undefined
                : (event) => updateLiveRequestFromFailover(liveRequests, liveRequestId!, event),
            requestFor: (routeTarget) => ({
              url: responseTargetUrl(routedRequest.route, requestUrl.search),
              init: {
                method: request.method,
                headers,
                body: JSON.stringify({
                  ...translatedPayload,
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
        effectivePayload: captureEffectivePayload,
        requestSummary: processed.requestSummary,
        transformationChanged: processed.transformationChanged,
        transformationExecutions: processed.transformationExecutions,
        harness,
        project,
        routing,
        origin,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text();
      await recorder.record("http", "upstream_to_client", errorBody, "utf8", {
        harness,
        project,
        origin,
        ...(routing === undefined ? {} : { usageFor: routing }),
      });
      if (liveRequestId !== undefined) {
        liveRequests.finish(liveRequestId, { state: "failed", status: response.status });
      }
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: downstreamHeaders(response.headers),
      });
    }

    let routedBody = response.body;
    const translatedStream =
      toolBridge !== undefined &&
      routedRequest?.route.api !== "anthropic-messages" &&
      response.ok &&
      routedBody !== null &&
      response.headers.get("content-type")?.includes("text/event-stream");
    if (translatedStream) routedBody = translateResponsesStream(routedBody!, toolBridge!);
    const translatedJson =
      toolBridge !== undefined &&
      routedRequest?.route.api !== "anthropic-messages" &&
      response.ok &&
      !translatedStream &&
      response.headers.get("content-type")?.includes("application/json");
    if (translatedJson) {
      const rewritten = toolBridge!.response(await response.json());
      routedBody = new Response(JSON.stringify(rewritten)).body;
      const completedEvent = JSON.stringify({ type: "response.completed", response: rewritten });
      const usage = observePayload(completedEvent, "upstream_to_client").responseSummary?.usage;
      if (usage && routing) recorder.recordUsage(routing, usage);
      if (responseStateKey !== undefined && preparedStoredRequest !== undefined) {
        const completed = completedStoredResponse(
          completedEvent,
          routedRequest!.route.model.slug,
          preparedStoredRequest.inputMarkers,
        );
        if (completed !== undefined) storedResponses.set(responseStateKey, completed);
      }
    }
    if (
      routedRequest?.route.api === "anthropic-messages" &&
      routing &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const serialized = await response.text();
      routedBody = new Response(serialized).body;
      const result: unknown = JSON.parse(serialized);
      const usage = observePayload(
        JSON.stringify({ type: "response.completed", response: result }),
        "upstream_to_client",
      ).responseSummary?.usage;
      if (usage) recorder.recordUsage(routing, usage);
    }
    let routedStreamFailed = false;
    let downstreamBody =
      routedRequest !== undefined && routing !== undefined && response.ok && routedBody !== null
        ? tapRoutedUsage(routedBody, routing, recorder, (eventData) => {
            try {
              routedStreamFailed ||= ["response.failed", "response.incomplete", "error"].includes(
                JSON.parse(eventData).type,
              );
            } catch {
              /* observation only */
            }
            if (responseStateKey === undefined || preparedStoredRequest === undefined) return;
            const completed = completedStoredResponse(
              eventData,
              routedRequest.route.model.slug,
              preparedStoredRequest.inputMarkers,
            );
            if (completed !== undefined) storedResponses.set(responseStateKey, completed);
          })
        : routedBody;
    if (liveRequestId !== undefined) {
      liveRequests.update(liveRequestId, { state: "streaming", status: response.status });
      if (downstreamBody === null) {
        liveRequests.finish(liveRequestId, { state: "completed", status: response.status });
      } else {
        downstreamBody = trackResponseBody(
          downstreamBody,
          () =>
            liveRequests.finish(liveRequestId!, {
              state: routedStreamFailed ? "failed" : "completed",
              status: response.status,
            }),
          (error) =>
            liveRequests.finish(liveRequestId!, {
              state: "failed",
              status: response.status,
              detail: errorMessage(error),
            }),
        );
      }
    }
    const downstream = new Response(downstreamBody, {
      status: response.status,
      statusText: response.statusText,
      headers:
        translatedStream || translatedJson
          ? translatedHeaders(response.headers)
          : downstreamHeaders(response.headers),
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
    if (liveRequestId !== undefined) {
      liveRequests.finish(liveRequestId, { state: "failed", detail: errorMessage(error) });
    }
    return new Response(error instanceof CaptureFailure ? "capture failed" : errorMessage(error), {
      status:
        error instanceof RequestTooLarge
          ? 413
          : error instanceof ToolPolicyError
            ? 400
            : error instanceof RouteUnavailable
              ? 502
              : 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

function noteToolOmissions(
  route: ModelRoute,
  omittedTypes: readonly string[],
  liveRequests: LiveRequestStore,
  liveRequestId: string | undefined,
): void {
  if (omittedTypes.length === 0) return;
  warnOmittedToolTypes(route.model.slug, omittedTypes);
  if (liveRequestId !== undefined) {
    liveRequests.update(liveRequestId, {
      detail: `Omitted tool types: ${omittedTypes.join(", ")}`,
    });
  }
}

function updateLiveRequestFromFailover(
  requests: LiveRequestStore,
  id: string,
  event: FailoverEvent,
): void {
  if (event.type === "breaker-open") {
    requests.update(id, {
      state: "falling-back",
      targetModel: event.upstreamModel,
      targetIndex: event.targetIndex,
      detail: "Circuit breaker open; skipping target",
    });
    return;
  }
  if (event.type === "backoff") {
    requests.update(id, {
      state: "retrying",
      targetModel: event.upstreamModel,
      targetIndex: event.targetIndex,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      detail: `Backing off for ${event.delayMs}ms`,
    });
    return;
  }
  if (event.type === "attempt-started") {
    requests.update(id, {
      state: event.targetIndex > 0 ? "falling-back" : event.attempt > 1 ? "retrying" : "connecting",
      targetModel: event.upstreamModel,
      targetIndex: event.targetIndex,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      detail:
        event.targetIndex > 0
          ? "Trying fallback target"
          : event.attempt > 1
            ? "Retrying target"
            : "Connecting to target",
    });
    return;
  }
  requests.update(id, {
    state:
      event.outcome === "served"
        ? "streaming"
        : event.outcome === "retry"
          ? "retrying"
          : event.outcome === "failover" || event.outcome === "network-error"
            ? "falling-back"
            : "failed",
    targetModel: event.upstreamModel,
    targetIndex: event.targetIndex,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    ...(event.status === undefined ? {} : { status: event.status }),
    detail: event.outcome,
  });
}

function trackResponseBody(
  body: ReadableStream<Uint8Array>,
  onComplete: () => void,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          onComplete();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        onError(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
        onComplete();
      } catch (error) {
        onError(error);
      }
    },
  });
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
  breakers: TargetBreakers,
  liveRequests: LiveRequestStore,
  storedResponses: StoredResponseRegistry,
  loadedTools: LoadedToolRegistry,
  anthropicKey: Uint8Array,
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
      liveRequests,
      continuationSession: continuationSessionKey(request.headers),
      storedResponses,
      loadedTools,
      anthropicKey,
    };

    if (lazyRouting) {
      const defaultTarget = webSocketTarget(targetUrl(upstreamOrigin, request.url));
      data.bridge = { routes, search: requestUrl.search, baseHeaders, breakers };
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
        data.upstreamOrigin = {
          kind: route === undefined ? "chatgpt-websocket" : "gateway-websocket",
          url: target.toString(),
        };
        attachUpstream(data, upstream);
        data.upstream = upstream;
        data.connectedRoute = route;
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

    const chatgptTarget = webSocketTarget(targetUrl(upstreamOrigin, request.url));
    const upstream = await connectWebSocket(chatgptTarget, baseHeaders, protocols);
    data.upstreamOrigin = { kind: "chatgpt-websocket", url: chatgptTarget.toString() };
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
        ...(data.lastRouting === undefined ? {} : { usageFor: data.lastRouting }),
        ...(data.upstreamOrigin === undefined ? {} : { origin: data.upstreamOrigin }),
      });
      const client = data.client;
      if (client === undefined || client.readyState !== WebSocket.OPEN) {
        throw new Error("client websocket is not open");
      }
      if (client.send(message) === 0) throw new Error("client websocket send failed");
      observeResponseEvent(data, message);
    })
    .catch(() => closePair(data, 1011, "capture failed"));
}

function matchBridgeRoute(
  bridge: BridgeContext | undefined,
  value: string | ArrayBuffer | Uint8Array,
):
  | { route: ModelRoute; inspected: { payload: Record<string, unknown>; model: string } }
  | undefined {
  if (bridge === undefined) return undefined;
  const inspected = inspectResponseModel(value);
  if (inspected === undefined) return undefined;
  const route = modelRouteFor(bridge.routes, inspected.model);
  if (route === undefined || route.transport !== "http") return undefined;
  return { route, inspected };
}

/**
 * Fulfills one response.create against an HTTP-only upstream: failover runs
 * first, the request event is recorded with the attempt trail, then the SSE
 * stream is forwarded to the client as WebSocket messages. Awaiting the whole
 * stream keeps client messages processed in order.
 */
async function runBridgedCreate(
  data: SocketData,
  route: ModelRoute,
  inspected: { payload: Record<string, unknown>; model: string },
  rawMessage: string | ArrayBuffer | Uint8Array,
  encoding: "utf8" | "base64",
  processed: ReturnType<typeof processClientPayload>,
): Promise<void> {
  const bridge = data.bridge;
  if (bridge === undefined) return;
  const liveRequestId = data.liveRequests.start({
    transport: "websocket",
    requestedModel: inspected.model,
    routeSlug: route.model.slug,
    upstream: responseTargetUrl(route, bridge.search).toString(),
    targetModel: route.targets[0]?.upstreamModel ?? route.model.slug,
  });
  data.activeRequestId = liveRequestId;
  const routingBase: CaptureRouting = {
    action: "routed",
    routeSlugs: [route.model.slug],
    upstream: route.upstream.origin,
    requestedModel: inspected.model,
    upstreamModel: route.targets[0]?.upstreamModel ?? route.model.slug,
  };
  const origin: CaptureUpstreamOrigin = {
    kind: "gateway-http",
    url: responseTargetUrl(route, bridge.search).toString(),
  };
  let captureEffectivePayload = processed.effectivePayload;
  const recordRequest = (routing: CaptureRouting) =>
    data.recorder.record("websocket", "client_to_upstream", rawMessage, encoding, {
      effectivePayload: captureEffectivePayload,
      requestSummary: processed.requestSummary,
      transformationChanged: processed.transformationChanged,
      transformationExecutions: processed.transformationExecutions,
      harness: data.harness,
      project: data.project,
      routing,
      origin,
    });

  const policy = applyRouteToolPolicy(route, inspected.payload);

  // Warmup creates (generate: false) are answered locally: forwarding them
  // would bill a real generation for a response the client ignores.
  if (inspected.payload.generate === false) {
    await recordRequest(routingBase);
    for (const event of warmupCompletionEvents(inspected.model)) {
      await queueBridgedMessage(data, event, origin);
    }
    data.liveRequests.finish(liveRequestId, { state: "completed", detail: "Local warmup" });
    return;
  }

  noteToolOmissions(route, policy.omittedTypes, data.liveRequests, liveRequestId);
  if (policy.omittedTypes.length > 0) {
    routingBase.omittedToolTypes = policy.omittedTypes;
    captureEffectivePayload = JSON.stringify(policy.payload);
  }

  let authorization: string;
  try {
    authorization = authorizationFor(route, process.env);
  } catch (error) {
    await recordRequest(routingBase);
    await queueBridgedMessage(data, wrappedErrorEvent(502, errorMessage(error)), origin);
    data.liveRequests.finish(liveRequestId, {
      state: "failed",
      detail: errorMessage(error),
    });
    return;
  }

  const forwardedPayload = httpPayloadFor(policy.payload, {
    forwardAccessPrograms: route.forwardAccessPrograms,
    storeResponses: route.bridgeResponseState === "stored",
  });
  const responseStateKey = storedResponseKey(
    data.continuationSession,
    route.model.slug,
    responseTargetUrl(route, bridge.search).toString(),
    route.targets[0]?.upstreamModel ?? route.model.slug,
    authorization,
  );
  const storedRequest =
    route.bridgeResponseState === "stored"
      ? prepareStoredRequest(
          forwardedPayload,
          route.model.slug,
          responseStateKey === undefined
            ? data.storedResponse
            : data.storedResponses.get(responseStateKey),
        )
      : undefined;
  const requestPayload = storedRequest?.payload ?? forwardedPayload;
  const searchPayload =
    route.toolPolicy.tool_search === "translate"
      ? data.loadedTools.prepare(
          route.model.slug,
          responseStateKey,
          forwardedPayload,
          requestPayload,
        )
      : requestPayload;
  const toolBridge = createResponsesToolBridge(route, searchPayload.tools);
  const translatedPayload = toolBridge?.request(searchPayload) ?? searchPayload;
  if (toolBridge !== undefined || searchPayload !== requestPayload)
    captureEffectivePayload = JSON.stringify(translatedPayload);
  data.bridgeAbort = new AbortController();
  const result = await fetchWithFailover({
    route,
    signal: data.bridgeAbort.signal,
    fetchImpl:
      route.api === "anthropic-messages"
        ? anthropicFetch(route, data.anthropicKey, data.bridgeAbort.signal)
        : undefined,
    breakers: bridge.breakers,
    onEvent: (event) => updateLiveRequestFromFailover(data.liveRequests, liveRequestId, event),
    requestFor: (target) => ({
      url: responseTargetUrl(route, bridge.search),
      init: {
        method: "POST",
        headers: {
          ...routedHeaders(bridge.baseHeaders, authorization),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          ...translatedPayload,
          model: target.upstreamModel ?? route.model.slug,
          stream: true,
        }),
        redirect: "manual",
      },
    }),
  });
  const routing: CaptureRouting = {
    ...routingBase,
    ...(result.servedBy === undefined ? {} : { upstreamModel: result.servedBy }),
    attempts: result.attempts,
  };
  data.lastRouting = routing;
  await recordRequest(routing);

  if (!result.response.ok || result.response.body === null) {
    data.bridgeAbort = undefined;
    const detail = await result.response.text();
    await queueBridgedMessage(data, wrappedErrorEvent(result.response.status, detail), origin);
    data.liveRequests.finish(liveRequestId, {
      state: "failed",
      status: result.response.status,
      detail,
    });
    return;
  }
  data.liveRequests.update(liveRequestId, {
    state: "streaming",
    status: result.response.status,
  });
  let failed = false;
  for await (const eventData of parseSseEvents(result.response.body)) {
    for (const translatedEvent of toolBridge?.event(eventData) ?? [eventData]) {
      try {
        const type = JSON.parse(translatedEvent).type;
        failed ||= ["response.failed", "response.incomplete", "error"].includes(type);
      } catch {
        /* upstream data is recorded verbatim */
      }
      if (data.client === undefined || data.client.readyState !== WebSocket.OPEN) break;
      const completed = completedStoredResponse(
        translatedEvent,
        route.model.slug,
        storedRequest?.inputMarkers,
      );
      if (completed !== undefined) {
        if (responseStateKey === undefined) data.storedResponse = completed;
        else data.storedResponses.set(responseStateKey, completed);
      }
      await queueBridgedMessage(
        data,
        rewriteBridgedEvent(translatedEvent, route.model.slug, {
          preserveResponseId: route.bridgeResponseState === "stored",
        }),
        origin,
      );
    }
  }
  data.bridgeAbort = undefined;
  data.liveRequests.finish(liveRequestId, {
    state: failed ? "failed" : "completed",
    status: result.response.status,
  });
}

function queueBridgedMessage(
  data: SocketData,
  message: string,
  origin: CaptureUpstreamOrigin,
): Promise<void> {
  data.upstreamToClient = data.upstreamToClient
    .then(async () => {
      await data.recorder.record("websocket", "upstream_to_client", message, "utf8", {
        harness: data.harness,
        project: data.project,
        ...(data.lastRouting === undefined ? {} : { usageFor: data.lastRouting }),
        origin,
      });
      const client = data.client;
      if (client === undefined || client.readyState !== WebSocket.OPEN) {
        throw new Error("client websocket is not open");
      }
      if (client.send(message) === 0) throw new Error("client websocket send failed");
      observeResponseEvent(data, message);
    })
    .catch(() => closePair(data, 1011, "capture failed"));
  return data.upstreamToClient;
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

function translatedHeaders(incoming: Headers): Headers {
  const headers = downstreamHeaders(incoming);
  for (const name of ["content-length", "content-encoding", "etag"]) headers.delete(name);
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
  if (data.activeRequestId !== undefined) {
    data.liveRequests.finish(data.activeRequestId, { state: "failed", detail: reason });
    data.activeRequestId = undefined;
  }
  if (data.client !== undefined) closeClient(data.client, code, reason);
  if (data.upstream !== undefined) closeUpstream(data.upstream, code, reason);
}

function observeResponseEvent(data: SocketData, message: string | ArrayBuffer | Uint8Array): void {
  if (data.activeRequestId === undefined || typeof message !== "string") return;
  try {
    const event = JSON.parse(message) as { type?: unknown; status?: unknown };
    if (event.type === "response.created") {
      data.liveRequests.update(data.activeRequestId, { state: "streaming" });
      return;
    }
    if (event.type === "response.completed") {
      data.liveRequests.finish(data.activeRequestId, { state: "completed" });
      data.activeRequestId = undefined;
      return;
    }
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.error"
    ) {
      data.liveRequests.finish(data.activeRequestId, {
        state: "failed",
        ...(typeof event.status === "number" ? { status: event.status } : {}),
      });
      data.activeRequestId = undefined;
    }
  } catch {
    // Non-JSON WebSocket frames are unrelated to Responses lifecycle state.
  }
}

function closeClient(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const valid = sanitizeCloseCode(code);
  if (valid === undefined) socket.close();
  else socket.close(valid, reason);
}

/** Observe each complete SSE event before its bytes reach the HTTP client. */
function tapRoutedUsage(
  body: ReadableStream<Uint8Array>,
  routing: CaptureRouting,
  recorder: EventRecorder,
  onEvent?: (eventData: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = new SseEventScanner();
  const observe = (eventData: string) => {
    try {
      onEvent?.(eventData);
    } catch {
      // Continuation metadata is best-effort.
    }
    try {
      const usage = observePayload(eventData, "upstream_to_client").responseSummary?.usage;
      if (usage !== undefined) recorder.recordUsage(routing, usage);
    } catch {
      // Usage observation must not interrupt the upstream stream.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          for (const eventData of scanner.finish()) observe(eventData);
          reader.releaseLock();
          controller.close();
          return;
        }
        for (const eventData of scanner.push(value)) observe(eventData);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
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

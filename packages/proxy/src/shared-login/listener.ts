import { sanitizeCloseCode } from "../proxy/server.ts";
import type { ClientKeyStore } from "./client-keys.ts";
import { LoginUnavailableError, type LoginSource, type UpstreamCredential } from "./login.ts";
import { inspectFrame, inspectRequestBody, upstreamTarget } from "./policy.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_CONNECT_MS = 15_000;
const CLOSE_HANDSHAKE_MS = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_INTERNAL = 1011;

/** Headers Codex sends that upstream may need. Nothing else from a client is forwarded. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "thread-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "version",
  "x-client-request-id",
  "x-openai-internal-codex-responses-lite",
  "x-openai-memgen-request",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);
const FORWARDED_REQUEST_PREFIX = "x-codex-";
const WITHHELD_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "location",
  "set-cookie",
  "transfer-encoding",
];

export interface SharedLoginListenerOptions {
  host: string;
  port: number;
  upstreamOrigin: string;
  keys: ClientKeyStore;
  login: LoginSource;
  tls?: { cert: string; key: string };
  log: (line: string) => void;
}

export interface SharedLoginListener {
  origin: string;
  close(): Promise<void>;
}

interface RelayData {
  keyId: string;
  keyName: string;
  upstream: WebSocket;
}

type Server = Bun.Server<RelayData>;

export async function startSharedLoginListener(
  options: SharedLoginListenerOptions,
): Promise<SharedLoginListener> {
  const { keys, login, log } = options;
  const upstreamOrigin = new URL(options.upstreamOrigin);
  const relays = new Set<Bun.ServerWebSocket<RelayData>>();
  const stopRevocations = keys.onRevoke((id) => {
    for (const relay of relays) {
      if (relay.data.keyId !== id) continue;
      log(`refused ${relay.data.keyName} websocket: Client Key revoked`);
      relay.close(CLOSE_POLICY, "Client Key revoked");
    }
  });

  const handle = async (request: Request, serving: Server): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const key = keys.verify(bearerToken(request));
    if (key === undefined) {
      log(`refused ${request.method} ${url.pathname}: invalid key`);
      return clientError(401, "invalid_client_key", "Invalid Client Key");
    }
    const label = `${key.name} ${request.method} ${url.pathname}`;
    const refuse = (status: number, code: string, message: string, reason = message) => {
      log(`refused ${label}: ${reason}`);
      return clientError(status, code, message);
    };

    const webSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const path = upstreamTarget(request.method, url.pathname, url.searchParams, webSocket);
    if (path === undefined)
      return refuse(403, "path_not_allowed", "Path not available through Shared Login");
    const target = new URL(path, upstreamOrigin);

    let body: string | undefined;
    if (request.method === "POST") {
      if (request.headers.has("content-encoding"))
        return refuse(415, "encoded_body", "Compressed request bodies are not accepted");
      const verdict = inspectRequestBody(await request.arrayBuffer(), target.pathname);
      if ("refused" in verdict) return refuse(400, "payload_refused", verdict.refused);
      body = verdict.forward;
    }

    let credential: UpstreamCredential;
    try {
      credential = await login.credential();
    } catch (error) {
      if (!(error instanceof LoginUnavailableError)) throw error;
      // The detail names the owner's files, so only the log gets it.
      return refuse(503, "login_unavailable", "Shared Login is unavailable", error.message);
    }
    const headers = upstreamHeaders(request.headers, credential);

    if (webSocket) {
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      let upstream: WebSocket;
      try {
        // Connect first, so an upstream refusal reaches the client as an HTTP status.
        upstream = await connectUpstream(target, headers);
      } catch {
        return refuse(502, "upstream_unreachable", "Upstream could not be reached");
      }
      if (serving.upgrade(request, { data: { keyId: key.id, keyName: key.name, upstream } }))
        return undefined;
      upstream.close(CLOSE_INTERNAL, "client upgrade failed");
      return refuse(400, "upgrade_failed", "WebSocket upgrade failed");
    }

    // Streams can pause for long stretches; do not let Bun's idle timer cut them.
    serving.timeout(request, 0);
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch {
      return refuse(502, "upstream_unreachable", "Upstream could not be reached");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return refuse(502, "upstream_redirect", "Upstream answered with a redirect");
    }
    log(`${label} ${response.status}`);
    const responseHeaders = new Headers(response.headers);
    for (const name of WITHHELD_RESPONSE_HEADERS) responseHeaders.delete(name);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  };

  const internalError = (context: string, error: unknown) => {
    log(`failed ${context}: ${errorMessage(error)}`);
    return clientError(500, "internal", "Internal error");
  };

  const server = Bun.serve<RelayData>({
    hostname: options.host,
    port: options.port,
    tls: options.tls,
    development: false,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request, serving) {
      try {
        return await handle(request, serving);
      } catch (error) {
        return internalError(`${request.method} ${new URL(request.url).pathname}`, error);
      }
    },
    error: (error) => internalError("request", error),
    websocket: {
      idleTimeout: 255,
      maxPayloadLength: MAX_BODY_BYTES,
      backpressureLimit: MAX_BODY_BYTES,
      closeOnBackpressureLimit: true,
      open(client) {
        const { data } = client;
        relays.add(client);
        log(`${data.keyName} websocket open`);
        data.upstream.onmessage = (event) => {
          client.send(event.data as string | Uint8Array);
        };
        data.upstream.onclose = (event) => {
          log(`${data.keyName} websocket closed ${event.code}`);
          client.close(sanitizeCloseCode(event.code));
        };
      },
      message(client, frame) {
        const { data } = client;
        const refuse = (code: number, reason: string) => {
          log(`refused ${data.keyName} websocket: ${reason}`);
          client.close(code, reason);
        };
        try {
          // Revocation also closes the socket at once; this covers a frame already in flight.
          if (!keys.list().some((key) => key.id === data.keyId))
            return refuse(CLOSE_POLICY, "Client Key revoked");
          if (typeof frame !== "string")
            return refuse(CLOSE_UNSUPPORTED, "binary frames are not accepted");
          const verdict = inspectFrame(frame);
          if ("refused" in verdict) return refuse(CLOSE_POLICY, verdict.refused);
          data.upstream.send(verdict.forward);
        } catch (error) {
          log(`failed ${data.keyName} websocket: ${errorMessage(error)}`);
          client.close(CLOSE_INTERNAL, "internal error");
        }
      },
      close(client) {
        relays.delete(client);
        client.data.upstream.close();
      },
    },
  });

  return {
    origin: server.url.origin,
    async close() {
      stopRevocations();
      for (const relay of relays) {
        relay.data.upstream.close();
        relay.close(CLOSE_GOING_AWAY, "Shared Login stopped");
      }
      // Bun keeps counting a closed WebSocket until its closing handshake finishes, and
      // stop(true) waits for that count rather than forcing it. Give clients a bounded moment.
      const deadline = Date.now() + CLOSE_HANDSHAKE_MS;
      while (server.pendingWebSockets > 0 && Date.now() < deadline) await Bun.sleep(10);
      await Promise.race([server.stop(true), Bun.sleep(CLOSE_HANDSHAKE_MS)]);
    },
  };
}

function connectUpstream(url: URL, headers: Headers): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's client accepts headers; the standard constructor type does not declare them.
    const socket = new WebSocket(url, {
      headers: Object.fromEntries(headers),
    } as unknown as string[]);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("upstream WebSocket connection timed out"));
    }, UPSTREAM_CONNECT_MS);
    const settle = (outcome: () => void) => () => {
      clearTimeout(timer);
      outcome();
    };
    socket.addEventListener(
      "open",
      settle(() => resolve(socket)),
      { once: true },
    );
    socket.addEventListener(
      "error",
      settle(() => reject(new Error("upstream WebSocket connection failed"))),
      { once: true },
    );
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function upstreamHeaders(incoming: Headers, credential: UpstreamCredential): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (FORWARDED_REQUEST_HEADERS.has(name) || name.startsWith(FORWARDED_REQUEST_PREFIX))
      headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  headers.set("chatgpt-account-id", credential.accountId);
  return headers;
}

function clientError(status: number, code: string, message: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

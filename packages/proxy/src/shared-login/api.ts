import type { SharedLoginService } from "./service.ts";

const PATH = "/__crabex/api/shared-login";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Serves settings and key management. Issuing a key hands out access to the login, so only this
 * machine may use it, whatever address the main listener has: the peer must be loopback (reach
 * it remotely through an SSH tunnel), the hostname must be loopback (no DNS rebinding), a sent
 * Origin must match, and writes need a JSON content type, which forces a CORS preflight this API
 * never approves.
 */
export function createSharedLoginApi(service: SharedLoginService) {
  const originRefusal = (request: Request, url: URL, peer: string | undefined) => {
    if (peer === undefined || !LOOPBACK_PEERS.has(peer))
      return json({ error: "Shared Login settings are only available from this machine" }, 403);
    if (!LOOPBACK_HOSTS.has(url.hostname)) return json({ error: "host not allowed" }, 403);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin)
      return json({ error: "cross-origin requests are not allowed" }, 403);
    if (request.method === "GET" || request.method === "DELETE") return undefined;
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return json({ error: "content type must be application/json" }, 415);
    return undefined;
  };

  const state = async () => ({
    ...service.status(),
    login: await service.login.status(),
    keys: service.keys.list(),
  });

  return async (request: Request, peer: string | undefined): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PATH && !url.pathname.startsWith(`${PATH}/`)) return undefined;
    const refusal = originRefusal(request, url, peer);
    if (refusal !== undefined) return refusal;
    try {
      if (url.pathname === PATH) {
        if (request.method === "PUT") {
          const update: unknown = await request.json();
          if (typeof update !== "object" || update === null || Array.isArray(update))
            throw new Error("expected an object with enabled, listen and/or refresh");
          const { enabled, listen, refresh } = update as Record<string, unknown>;
          if (enabled !== undefined && typeof enabled !== "boolean")
            throw new Error("enabled must be boolean");
          if (refresh !== undefined && typeof refresh !== "boolean")
            throw new Error("refresh must be boolean");
          if (listen !== undefined && typeof listen !== "string")
            throw new Error("listen must be host:port");
          await service.update({ enabled, listen, refresh });
        } else if (request.method !== "GET") {
          return json({ error: "method not allowed" }, 405);
        }
        return json(await state());
      }
      if (url.pathname === `${PATH}/keys`) {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const { name } = (await request.json()) as { name?: unknown };
        if (typeof name !== "string") throw new Error("Client Key name is required");
        return json({ key: await service.keys.issue(name) });
      }
      if (url.pathname.startsWith(`${PATH}/keys/`)) {
        if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
        await service.keys.revoke(decodeURIComponent(url.pathname.slice(`${PATH}/keys/`.length)));
        return json(await state());
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/** Single-account, process-local credential reuse for the ChatGPT Apps MCP endpoint. */
export class AppsAuthRelay {
  #credentials: { authorization: string; account: string } | undefined;
  #accountChanged = false;
  #closed = false;
  readonly #waiters = new Set<() => void>();

  observe(request: Request): void {
    if (this.#closed || this.#accountChanged) return;
    const path = new URL(request.url).pathname;
    // Apps can carry a separately configured bearer token: never treat it as
    // the ambient Codex login. Local UI/API requests cannot seed the relay.
    if (!path.startsWith("/backend-api/") || path.startsWith("/backend-api/ps/mcp")) return;
    const authorization = request.headers.get("authorization");
    const account = request.headers.get("chatgpt-account-id");
    if (!authorization?.startsWith("Bearer ") || !authorization.slice(7).trim() || !account) return;
    if (this.#credentials !== undefined && this.#credentials.account !== account) {
      this.#credentials = undefined;
      this.#accountChanged = true;
    } else {
      this.#credentials = { authorization, account };
    }
    for (const wake of this.#waiters) wake();
  }

  async authenticate(request: Request): Promise<Request | Response> {
    if (
      new URL(request.url).pathname !== "/backend-api/ps/mcp" ||
      request.headers.has("authorization")
    ) {
      return request;
    }
    if (this.#credentials === undefined && !this.#accountChanged && !this.#closed) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          this.#waiters.delete(finish);
          request.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timeout = setTimeout(finish, 5_000);
        this.#waiters.add(finish);
        request.signal.addEventListener("abort", finish, { once: true });
        if (request.signal.aborted) finish();
      });
    }
    const credentials = this.#credentials;
    const requestedAccount = request.headers.get("chatgpt-account-id");
    if (
      this.#accountChanged ||
      (credentials !== undefined &&
        requestedAccount !== null &&
        requestedAccount !== credentials.account)
    ) {
      return this.#unavailable(
        "Apps authentication relay supports one account. Restart the proxy after switching accounts.",
      );
    }
    if (credentials === undefined || this.#closed || request.signal.aborted) {
      return this.#unavailable(
        "Apps authentication relay is waiting for an authenticated Codex request. Retry after Codex fetches its config or models.",
      );
    }
    const headers = new Headers(request.headers);
    headers.set("authorization", credentials.authorization);
    headers.set("chatgpt-account-id", credentials.account);
    return new Request(request, { headers });
  }

  close(): void {
    this.#closed = true;
    this.#credentials = undefined;
    for (const wake of this.#waiters) wake();
  }

  #unavailable(message: string): Response {
    return Response.json({ error: message }, { status: 503, headers: { "retry-after": "1" } });
  }
}

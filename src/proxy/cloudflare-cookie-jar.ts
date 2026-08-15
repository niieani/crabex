const CLOUDFLARE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

export class CloudflareCookieJar {
  readonly #cookies = new Map<string, string>();

  capture(headers: Headers): void {
    const setCookies = headers.getSetCookie();
    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator < 1) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!isCloudflareCookie(name)) continue;

      if (value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function isCloudflareCookie(name: string): boolean {
  return CLOUDFLARE_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

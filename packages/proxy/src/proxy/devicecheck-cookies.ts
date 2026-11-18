/** Relay only ChatGPT's device registration cookie, scoped to the proxy host. */
export function deviceCheckCookies(incoming: Headers, target?: URL): string[] {
  if (target?.origin !== "https://chatgpt.com" || target.pathname !== "/backend-api/devicecheck")
    return [];
  return (
    incoming
      .getSetCookie()
      .filter((cookie) => cookie.startsWith("_devicecheck="))
      // The upstream Domain cannot be set by a localhost response. Removing it
      // makes the cookie host-only; all other security and lifetime attributes stay.
      .map((cookie) => cookie.replace(/;\s*Domain=[^;]*/gi, ""))
  );
}

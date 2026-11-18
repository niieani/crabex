import { describe, expect, it } from "vite-plus/test";
import { deviceCheckCookies } from "./devicecheck-cookies.ts";

describe("device-check response cookies", () => {
  const target = new URL("https://chatgpt.com/backend-api/devicecheck");
  it("relays only the device cookie and preserves security and expiry attributes", () => {
    const headers = new Headers();
    headers.append("set-cookie", "__cf_bm=private; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", "session=private; Domain=.example.com; Secure");
    headers.append(
      "set-cookie",
      "_devicecheck=test; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=None; Expires=Wed, 18 Nov 2026 00:00:00 GMT",
    );
    expect(deviceCheckCookies(headers, target)).toEqual([
      "_devicecheck=test; Path=/; Secure; HttpOnly; SameSite=None; Expires=Wed, 18 Nov 2026 00:00:00 GMT",
    ]);
    expect(headers.getSetCookie()[2]).toContain("Domain=.example.com");
  });
  it("preserves host-only cookies and cookie deletion", () => {
    const headers = new Headers();
    headers.append("set-cookie", "_devicecheck=test; Path=/; Secure; HttpOnly");
    headers.append(
      "set-cookie",
      "_devicecheck=; domain=example.com; Path=/; Max-Age=0; Secure; HttpOnly",
    );
    expect(deviceCheckCookies(headers, target)).toEqual([
      "_devicecheck=test; Path=/; Secure; HttpOnly",
      "_devicecheck=; Path=/; Max-Age=0; Secure; HttpOnly",
    ]);
  });
  it.each([
    undefined,
    "https://chatgpt.com/backend-api/me",
    "https://chatgpt.com/backend-api/devicecheck/extra",
    "https://example.com/backend-api/devicecheck",
    "http://chatgpt.com/backend-api/devicecheck",
    "https://chatgpt.com:8443/backend-api/devicecheck",
  ])("does not relay cookies for other upstreams or endpoints: %s", (url) => {
    const headers = new Headers({ "set-cookie": "_devicecheck=test; Secure" });
    expect(deviceCheckCookies(headers, url === undefined ? undefined : new URL(url))).toEqual([]);
  });
});

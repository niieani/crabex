import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createWebUi } from "./web-ui.ts";

describe("single-port web UI", () => {
  it("serves client routes and assets without claiming upstream API requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relaydeck-web-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<title>Relaydeck</title>");
    await writeFile(join(directory, "assets", "app-123.js"), "export {};");
    const handle = createWebUi(directory);
    const page = await handle(new Request("http://localhost/routes"));
    expect(await page?.text()).toContain("Relaydeck");
    expect(page?.headers.get("cache-control")).toBe("no-cache");
    const asset = await handle(new Request("http://localhost/assets/app-123.js"));
    expect(asset?.headers.get("cache-control")).toContain("immutable");
    expect((await handle(new Request("http://localhost/assets/missing.js")))?.status).toBe(404);
    expect((await handle(new Request("http://localhost/assets/%invalid")))?.status).toBe(400);
    expect(await handle(new Request("http://localhost/backend-api/codex/models"))).toBeUndefined();
    expect(await handle(new Request("http://localhost/api/auth/session"))).toBeUndefined();
    expect((await handle(new Request("http://localhost/", { method: "POST" })))?.status).toBe(405);
    expect(await (await handle(new Request("http://localhost/", { method: "HEAD" })))?.text()).toBe(
      "",
    );
    expect((await handle(new Request("http://localhost/assets/..%2f..%2fsecret")))?.status).toBe(
      404,
    );
  });

  it("explains a missing build instead of forwarding UI requests upstream", async () => {
    const response = await createWebUi(undefined)(new Request("http://localhost/"));
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("vp run build");
  });
});

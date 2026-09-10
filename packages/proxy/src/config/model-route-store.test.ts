import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { ModelRouteConfig } from "../routing/model-routes.ts";
import { openModelRouteStore } from "./model-route-store.ts";

const routes: ModelRouteConfig[] = [
  {
    authorization_env: "CLIPROXYAPI_KEY",
    model: {
      description: "Kimi K3 via CLIProxyAPI",
      display_name: "Kimi K3",
      priority: 1,
      slug: "kimi-k3",
      template_slug: "gpt-5.6-terra",
    },
    upstream: "http://127.0.0.1:8317/v1",
    upstream_model: "kimi-k3",
  },
];

describe("model route store", () => {
  it("starts empty and atomically persists a versioned set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const store = await openModelRouteStore(path);

    expect(store.get()).toEqual([]);
    await store.replace(routes);

    expect(store.get()).toEqual(routes);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, routes });
    expect((await openModelRouteStore(path)).get()).toEqual(routes);
  });

  it("loads a bare codex-enterprise route array", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    await Bun.write(path, JSON.stringify(routes));

    expect((await openModelRouteStore(path)).get()).toEqual(routes);
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    await Bun.write(path, '{"version":1,"routes":[{"model":{}}]}');

    await expect(openModelRouteStore(path)).rejects.toThrow(
      "route[0].authorization_env must be a non-empty string",
    );
  });
});

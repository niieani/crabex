import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

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

    expect(store.get()).toEqual({ routes: [], adjustments: [], fixture_pins: [] });
    await store.replace({ routes, adjustments: [], fixture_pins: [] });

    expect(store.get()).toEqual({ routes, adjustments: [], fixture_pins: [] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      routes,
      adjustments: [],
      fixture_pins: [],
    });
    expect((await openModelRouteStore(path)).get()).toEqual({
      routes,
      adjustments: [],
      fixture_pins: [],
    });
  });

  it("round-trips model adjustments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const store = await openModelRouteStore(path);
    const adjustments = [{ slug: "gpt-5.6-terra", overrides: { context_window: 1_000_000 } }];

    await store.replace({ routes, adjustments, fixture_pins: ["gpt-6-astra"] });

    expect((await openModelRouteStore(path)).get()).toEqual({
      routes,
      adjustments,
      fixture_pins: ["gpt-6-astra"],
    });
  });

  it("loads a bare codex-enterprise route array", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    await Bun.write(path, JSON.stringify(routes));

    expect((await openModelRouteStore(path)).get()).toEqual({
      routes,
      adjustments: [],
      fixture_pins: [],
    });
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    await Bun.write(path, '{"version":1,"routes":[{"model":{}}]}');

    await expect(openModelRouteStore(path)).rejects.toThrow(
      "route[0].authorization_env must be a non-empty string",
    );
  });

  it("rejects unmatched replacements on load and save before changing the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const mismatched = [
      {
        ...routes[0]!,
        model: {
          ...routes[0]!.model,
          template_slug: "gpt-6-astra",
          template_replacements: [{ find: "missing opening sentence", replace: "new" }],
        },
      },
    ];
    const store = await openModelRouteStore(path);
    await expect(
      store.replace({ routes: mismatched, adjustments: [], fixture_pins: [] }),
    ).rejects.toThrow(
      'route[0].model.template_replacements find "missing opening sentence" must match exactly once',
    );
    expect(store.get().routes).toEqual([]);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await Bun.write(path, JSON.stringify({ version: 1, routes: mismatched }));
    await expect(openModelRouteStore(path)).rejects.toThrow("must match exactly once");
  });

  it("uses the resolved upstream template and honors fixture pins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const replacement = [
      {
        ...routes[0]!,
        model: {
          ...routes[0]!.model,
          template_slug: "gpt-6-astra",
          template_replacements: [
            { find: "You are Codex, an agent based on GPT-6.", replace: "new" },
          ],
        },
      },
    ];
    const upstream = () => ({
      models: [{ slug: "gpt-6-astra", model_messages: { instructions_template: "Upstream text" } }],
    });
    const store = await openModelRouteStore(path, upstream);
    await expect(
      store.replace({ routes: replacement, adjustments: [], fixture_pins: [] }),
    ).rejects.toThrow("must match exactly once");
    await store.replace({ routes: replacement, adjustments: [], fixture_pins: ["gpt-6-astra"] });
    expect((await openModelRouteStore(path, upstream)).get().routes).toEqual(replacement);
  });

  it("validates the instruction text after model overrides, as catalog generation does", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const store = await openModelRouteStore(path);
    const adjusted = [
      {
        ...routes[0]!,
        model: {
          ...routes[0]!.model,
          template_slug: "gpt-6-astra",
          overrides: { model_messages: { instructions_template: "Custom opening sentence." } },
          template_replacements: [{ find: "Custom opening sentence.", replace: "Replacement." }],
        },
      },
    ];
    await store.replace({ routes: adjusted, adjustments: [], fixture_pins: [] });
    expect(store.get().routes).toEqual(adjusted);
  });

  it("warns when loading or saving legacy allowed_tool_types", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const legacy = [{ ...routes[0]!, allowed_tool_types: ["function"] }];
    await Bun.write(path, JSON.stringify({ version: 1, routes: legacy }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await openModelRouteStore(path);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('model route "kimi-k3": allowed_tool_types is deprecated'),
      );
      warning.mockClear();
      await store.replace({ routes: legacy, adjustments: [], fixture_pins: [] });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("loads a legacy allowlist containing a future declaration type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-routes-"));
    const path = join(directory, "routes.json");
    const legacy = [{ ...routes[0]!, allowed_tool_types: ["future_tool"] }];
    await Bun.write(path, JSON.stringify({ version: 1, routes: legacy }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await openModelRouteStore(path)).get().routes).toEqual(legacy);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('model route "kimi-k3": allowed_tool_types is deprecated'),
      );
    } finally {
      warning.mockRestore();
    }
  });
});

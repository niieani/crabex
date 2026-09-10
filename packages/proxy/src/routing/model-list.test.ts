import { describe, expect, it } from "vite-plus/test";

import { prependRoutedModels, prependRoutedModelsToResponse } from "./model-list.ts";
import type { ModelRoute } from "./model-routes.ts";

const route: ModelRoute = {
  authorizationEnv: "CLIPROXYAPI_KEY",
  enabled: true,
  model: {
    description: "Kimi K3 via CLIProxyAPI",
    displayName: "Kimi K3",
    overrides: {
      context_window: 1048576,
      input_modalities: ["text", "image"],
      multi_agent_version: null,
    },
    priority: 1,
    slug: "kimi-k3",
    templateSlug: "gpt-5.6-terra",
  },
  upstream: new URL("http://127.0.0.1:8317/v1"),
};

const template = {
  context_window: 272000,
  display_name: "GPT-5.6 Terra",
  input_modalities: ["text"],
  multi_agent_version: "v2",
  slug: "gpt-5.6-terra",
  upgrade: {
    model: "gpt-5.7",
    retirement_at: "2026-12-31T00:00:00Z",
  },
};

describe("prependRoutedModels", () => {
  it("applies local capability overrides and removes inherited lifecycle metadata", () => {
    const result = prependRoutedModels({ models: [template] }, [route]);

    expect(result.models).toEqual([
      {
        context_window: 1048576,
        description: "Kimi K3 via CLIProxyAPI",
        display_name: "Kimi K3",
        input_modalities: ["text", "image"],
        multi_agent_version: null,
        priority: 1,
        slug: "kimi-k3",
      },
      template,
    ]);
  });

  it("rejects a capability override absent from the template", () => {
    const invalidRoute: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        overrides: { unsupported: true },
      },
    };

    expect(() =>
      prependRoutedModels({ models: [{ slug: "gpt-5.6-terra" }] }, [invalidRoute]),
    ).toThrow("routed model kimi-k3 overrides missing template field unsupported");
  });

  it("rejects a route whose template is not advertised upstream", () => {
    expect(() => prependRoutedModels({ models: [{ slug: "gpt-5.6-luna" }] }, [route])).toThrow(
      "routed model kimi-k3 requires missing template gpt-5.6-terra",
    );
  });

  it("rejects duplicate routed slugs", () => {
    expect(() => prependRoutedModels({ models: [template] }, [route, route])).toThrow(
      "duplicate routed model slug: kimi-k3",
    );
  });

  it("keeps the advertised model when the upstream list contains the same slug", () => {
    const result = prependRoutedModels(
      { models: [template, { ...template, slug: "kimi-k3" }] },
      [route],
    );

    expect(result.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
    expect(result.models[0]).toMatchObject({ display_name: "Kimi K3" });
  });
});

describe("prependRoutedModelsToResponse", () => {
  it("prepends routed models and strips stale entity headers", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "512",
        etag: '"abc"',
      },
    });

    const response = await prependRoutedModelsToResponse(upstream, [route]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    const body = (await response.json()) as { models: Array<{ slug: string }> };
    expect(body.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
  });

  it("passes through non-OK upstream responses unchanged", async () => {
    const upstream = new Response("rate limited", { status: 429 });

    const response = await prependRoutedModelsToResponse(upstream, [route]);

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
  });

  it("fails with 502 when the upstream model list cannot be decorated", async () => {
    const upstream = new Response("not json", { status: 200 });

    const response = await prependRoutedModelsToResponse(upstream, [route]);

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Could not advertise routed models");
  });
});

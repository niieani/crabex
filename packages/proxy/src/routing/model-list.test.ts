import { describe, expect, it } from "vite-plus/test";

import { transformModels, transformModelsResponse } from "./model-list.ts";
import { modelRouteFromConfig, type ModelRoute } from "./model-routes.ts";

const route: ModelRoute = modelRouteFromConfig({
  authorization_env: "CLIPROXYAPI_KEY",
  model: {
    description: "Kimi K3 via CLIProxyAPI",
    display_name: "Kimi K3",
    overrides: {
      context_window: 1048576,
      input_modalities: ["text", "image"],
      multi_agent_version: null,
    },
    priority: 1,
    slug: "kimi-k3",
    template_slug: "gpt-5.6-terra",
  },
  upstream: "http://127.0.0.1:8317/v1",
});

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

describe("transformModels", () => {
  it("applies local capability overrides and removes inherited lifecycle metadata", () => {
    const result = transformModels({ models: [template] }, [route]);

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

  it("gates Codex search and apply_patch advertising after route adjustments", () => {
    const restricted = modelRouteFromConfig({
      authorization_env: "TEST_KEY",
      model: {
        description: "Restricted model",
        display_name: "Restricted model",
        priority: 1,
        slug: "restricted",
        template_slug: "gpt-5.6-terra",
      },
      upstream: "https://gateway.example/v1",
      tool_policy: { tool_search: "reject", custom: "reject" },
    });
    const result = transformModels(
      {
        models: [
          {
            ...template,
            supports_search_tool: true,
            apply_patch_tool_type: "freeform",
            tool_mode: "code_mode_only",
          },
        ],
      },
      [restricted],
      [
        {
          slug: "restricted",
          overrides: {
            supports_search_tool: true,
            apply_patch_tool_type: "freeform",
            tool_mode: "code_mode_only",
          },
        },
      ],
    );

    expect(result.models[0]).toMatchObject({
      slug: "restricted",
      supports_search_tool: false,
      apply_patch_tool_type: null,
      tool_mode: "direct",
    });
    expect(result.models[1]).toMatchObject({
      slug: "gpt-5.6-terra",
      supports_search_tool: true,
      apply_patch_tool_type: "freeform",
      tool_mode: "code_mode_only",
    });
  });

  it("gates Codex search and apply_patch advertising for omitted tools", () => {
    const omitted = modelRouteFromConfig({
      authorization_env: "TEST_KEY",
      model: {
        description: "Legacy route",
        display_name: "Legacy route",
        priority: 1,
        slug: "legacy-route",
        template_slug: "gpt-5.6-terra",
      },
      upstream: "https://gateway.example/v1",
      allowed_tool_types: ["function"],
    });

    const result = transformModels(
      {
        models: [{ ...template, supports_search_tool: true, apply_patch_tool_type: "freeform" }],
      },
      [omitted],
    );

    expect(result.models[0]).toMatchObject({
      slug: "legacy-route",
      supports_search_tool: false,
      apply_patch_tool_type: null,
      tool_mode: "direct",
    });
  });

  it("replaces one exact instruction span and updates the legacy field", () => {
    const instructions = "You are Codex, an agent based on GPT-5. Use the listed tools.";
    const routed: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        templateReplacements: [{ find: "based on GPT-5", replace: "powered by Kimi K3" }],
      },
    };
    const result = transformModels(
      {
        models: [
          {
            ...template,
            base_instructions: instructions,
            model_messages: {
              instructions_template: instructions,
              token_budget: { enabled: false },
            },
          },
        ],
      },
      [routed],
    );

    expect(result.models[0]?.model_messages).toEqual({
      instructions_template: "You are Codex, an agent powered by Kimi K3. Use the listed tools.",
      token_budget: { enabled: false },
    });
    expect(result.models[0]?.base_instructions).toBe(
      "You are Codex, an agent powered by Kimi K3. Use the listed tools.",
    );
  });

  it("rejects instruction replacements that are absent or ambiguous", () => {
    const model = { ...template, model_messages: { instructions_template: "GPT-5 and GPT-5" } };
    const routed: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        templateReplacements: [{ find: "GPT-5", replace: "Kimi K3" }],
      },
    };
    expect(() => transformModels({ models: [model] }, [routed])).toThrow(
      "requires exactly one instruction match",
    );
    expect(() =>
      transformModels(
        { models: [{ ...model, model_messages: { instructions_template: "Other" } }] },
        [routed],
      ),
    ).toThrow("requires exactly one instruction match");
  });

  it("rejects a capability override absent from the template", () => {
    const invalidRoute: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        overrides: { unsupported: true },
      },
    };

    expect(() => transformModels({ models: [{ slug: "gpt-5.6-terra" }] }, [invalidRoute])).toThrow(
      "routed model kimi-k3 overrides missing template field unsupported",
    );
  });

  it("rejects a route whose template is not advertised upstream", () => {
    expect(() => transformModels({ models: [{ slug: "gpt-5.6-luna" }] }, [route])).toThrow(
      "routed model kimi-k3 requires missing template gpt-5.6-terra",
    );
  });

  it("rejects duplicate routed slugs", () => {
    expect(() => transformModels({ models: [template] }, [route, route])).toThrow(
      "duplicate routed model slug: kimi-k3",
    );
  });

  it("keeps the advertised model when the upstream list contains the same slug", () => {
    const result = transformModels({ models: [template, { ...template, slug: "kimi-k3" }] }, [
      route,
    ]);

    expect(result.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
    expect(result.models[0]).toMatchObject({ display_name: "Kimi K3" });
  });

  it("deep-merges adjustments into matching upstream models", () => {
    const upstream = {
      models: [
        {
          ...template,
          model_messages: {
            instructions_template: "base instructions",
            token_budget: { enabled: false, reminder_threshold_tokens: 6144 },
          },
        },
      ],
    };

    const result = transformModels(
      upstream,
      [],
      [
        {
          slug: "gpt-5.6-terra",
          overrides: {
            context_window: 1_000_000,
            model_messages: { token_budget: { reminder_threshold_tokens: 8192 } },
          },
        },
        { slug: "not-advertised", overrides: { priority: 99 } },
      ],
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toEqual({
      ...template,
      context_window: 1_000_000,
      model_messages: {
        instructions_template: "base instructions",
        token_budget: { enabled: false, reminder_threshold_tokens: 8192 },
      },
    });
  });

  it("applies adjustments after prepending routed models", () => {
    const result = transformModels(
      { models: [template] },
      [route],
      [{ slug: "kimi-k3", overrides: { context_window: 777 } }],
    );

    expect(result.models[0]).toMatchObject({ slug: "kimi-k3", context_window: 777 });
  });
});

describe("transformModelsResponse", () => {
  it("keeps policy gates after local catalog transformations", async () => {
    const restricted = modelRouteFromConfig({
      authorization_env: "TEST_KEY",
      model: {
        description: "Restricted model",
        display_name: "Restricted model",
        priority: 1,
        slug: "restricted",
        template_slug: "gpt-5.6-terra",
      },
      upstream: "https://gateway.example/v1",
      tool_policy: { tool_search: "reject", custom: "reject" },
    });
    const response = await transformModelsResponse(Response.json({ models: [template] }), {
      routes: [restricted],
      applyTransformations: (models) =>
        models.map((model) => ({
          ...model,
          supports_search_tool: true,
          apply_patch_tool_type: "freeform",
          tool_mode: "code_mode_only",
        })),
    });

    const body = (await response.json()) as { models: Record<string, unknown>[] };
    expect(body.models[0]).toMatchObject({
      slug: "restricted",
      supports_search_tool: false,
      apply_patch_tool_type: null,
      tool_mode: "direct",
    });
  });

  it("prepends routed models and strips stale entity headers", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "512",
        etag: '"abc"',
      },
    });

    const response = await transformModelsResponse(upstream, { routes: [route] });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    const body = (await response.json()) as { models: Array<{ slug: string }> };
    expect(body.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
  });

  it("passes through non-OK upstream responses unchanged", async () => {
    const upstream = new Response("rate limited", { status: 429 });

    const response = await transformModelsResponse(upstream, { routes: [route] });

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
  });

  it("fails with 502 when the upstream model list cannot be decorated", async () => {
    const upstream = new Response("not json", { status: 200 });

    const response = await transformModelsResponse(upstream, { routes: [route] });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Could not advertise routed models");
  });

  it("observes the upstream body and passes through untouched when nothing is configured", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const observed: unknown[] = [];

    const response = await transformModelsResponse(upstream, {
      observe: async (body) => {
        observed.push(body);
      },
    });

    expect(observed).toEqual([{ models: [template] }]);
    expect(await response.json()).toEqual({ models: [template] });
  });

  it("observes the pre-transformation body when transforms apply", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });
    const observed: unknown[] = [];

    const response = await transformModelsResponse(upstream, {
      adjustments: [{ slug: "gpt-5.6-terra", overrides: { context_window: 1 } }],
      observe: async (body) => {
        observed.push(body);
      },
    });

    expect(observed).toEqual([{ models: [template] }]);
    const body = (await response.json()) as { models: Array<{ context_window: number }> };
    expect(body.models[0]?.context_window).toBe(1);
  });

  it("passes non-JSON bodies through when nothing is configured", async () => {
    const upstream = new Response("not json", { status: 200 });

    const response = await transformModelsResponse(upstream);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not json");
  });

  it("serves the fixture version of pinned slugs", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });
    const fixtureModel = { ...template, display_name: "GPT-5.6 Terra (fixture)" };

    const response = await transformModelsResponse(upstream, {
      fixture: { models: [fixtureModel], pins: ["gpt-5.6-terra"] },
    });

    const body = (await response.json()) as { models: Array<{ display_name: string }> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.display_name).toBe("GPT-5.6 Terra (fixture)");
  });

  it("keeps the upstream version when the slug is not pinned", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });
    const fixtureModel = { ...template, display_name: "GPT-5.6 Terra (fixture)" };

    const response = await transformModelsResponse(upstream, {
      fixture: { models: [fixtureModel], pins: [] },
    });

    const body = (await response.json()) as { models: Array<{ display_name: string }> };
    expect(body.models[0]?.display_name).toBe("GPT-5.6 Terra");
  });

  it("keeps the upstream version when the pinned slug is absent from the fixture", async () => {
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });

    const response = await transformModelsResponse(upstream, {
      fixture: { models: [], pins: ["gpt-5.6-terra"] },
    });

    const body = (await response.json()) as { models: Array<{ display_name: string }> };
    expect(body.models[0]?.display_name).toBe("GPT-5.6 Terra");
  });

  it("allows routes templated on fixture-only models", async () => {
    const astraRoute: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        slug: "my-astra",
        templateSlug: "gpt-6-astra",
        overrides: {},
      },
    };
    const astra = { slug: "gpt-6-astra", display_name: "GPT-6 Astra" };
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });

    const response = await transformModelsResponse(upstream, {
      routes: [astraRoute],
      fixture: { models: [astra] },
    });

    const body = (await response.json()) as { models: Array<{ slug: string }> };
    expect(body.models.map((model) => model.slug)).toEqual(["my-astra", "gpt-5.6-terra"]);
  });

  it("still rejects fixture-templated routes when no fixture is provided", async () => {
    const astraRoute: ModelRoute = {
      ...route,
      model: {
        ...route.model,
        slug: "my-astra",
        templateSlug: "gpt-6-astra",
        overrides: {},
      },
    };
    const upstream = new Response(JSON.stringify({ models: [template] }), { status: 200 });

    const response = await transformModelsResponse(upstream, { routes: [astraRoute] });

    expect(response.status).toBe(502);
  });
});

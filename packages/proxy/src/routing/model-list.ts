import type { ModelAdjustment, ModelRoute } from "./model-routes.ts";

export type ModelDefinition = Record<string, unknown> & { slug: string };

type ModelsResponse = Record<string, unknown> & { models: ModelDefinition[] };

/**
 * Fixture integration for the models list: `pins` are slugs served from the
 * baked-in fixture instead of the fetched upstream definition, and fixture
 * models act as template fallbacks for routes whose template slug is not in
 * the upstream list at all.
 */
export interface ModelsFixtureOptions {
  models: ModelDefinition[];
  pins?: readonly string[];
}

export function transformModels(
  response: unknown,
  modelRoutes: readonly ModelRoute[],
  adjustments: readonly ModelAdjustment[] = [],
  fixture?: ModelsFixtureOptions,
): ModelsResponse {
  if (!isRecord(response)) {
    throw new Error("upstream /models response must be a JSON object");
  }

  const fixtureBySlug = new Map((fixture?.models ?? []).map((model) => [model.slug, model]));
  const pins = new Set(fixture?.pins ?? []);
  const upstreamModels = modelDefinitions(response.models, "upstream /models response.models").map(
    (model) => (pins.has(model.slug) ? (fixtureBySlug.get(model.slug) ?? model) : model),
  );
  const templates = new Map(upstreamModels.map((model) => [model.slug, model]));
  for (const fixtureModel of fixture?.models ?? []) {
    if (!templates.has(fixtureModel.slug)) templates.set(fixtureModel.slug, fixtureModel);
  }
  const advertisedSlugs = new Set<string>();
  const advertisedModels = modelRoutes.map((route) => {
    if (advertisedSlugs.has(route.model.slug)) {
      throw new Error(`duplicate routed model slug: ${route.model.slug}`);
    }
    advertisedSlugs.add(route.model.slug);

    const template = templates.get(route.model.templateSlug);
    if (!template) {
      throw new Error(
        `routed model ${route.model.slug} requires missing template ${route.model.templateSlug}`,
      );
    }
    for (const field of Object.keys(route.model.overrides)) {
      if (!Object.hasOwn(template, field)) {
        throw new Error(
          `routed model ${route.model.slug} overrides missing template field ${field}`,
        );
      }
    }
    const model: ModelDefinition = {
      ...template,
      ...route.model.overrides,
      description: route.model.description,
      display_name: route.model.displayName,
      priority: route.model.priority,
      slug: route.model.slug,
    };
    if (route.model.templateReplacements.length > 0) {
      const messages = model.model_messages;
      if (!isRecord(messages) || typeof messages.instructions_template !== "string") {
        throw new Error(`routed model ${route.model.slug} requires an instruction template`);
      }
      let instructions = messages.instructions_template;
      for (const { find, replace } of route.model.templateReplacements) {
        const first = instructions.indexOf(find);
        if (first < 0 || instructions.indexOf(find, first + find.length) >= 0) {
          throw new Error(
            `routed model ${route.model.slug} requires exactly one instruction match: ${find}`,
          );
        }
        instructions =
          instructions.slice(0, first) + replace + instructions.slice(first + find.length);
      }
      model.model_messages = { ...messages, instructions_template: instructions };
      model.base_instructions = instructions;
    }
    if (route.api === "anthropic-messages") {
      model.use_responses_lite = false;
      model.tool_mode = route.model.overrides.tool_mode ?? null;
      model.supports_reasoning_summary_parameter = false;
      model.support_verbosity = false;
      model.supports_search_tool = false;
      model.web_search_tool_type = "text";
      model.supports_image_detail_original = false;
      model.additional_speed_tiers = [];
      model.service_tiers = [];
      model.available_access_programs = { cyber: [] };
      model.availability_nux = null;
      model.max_context_window = route.model.overrides.context_window ?? 200000;
      model.context_window = route.model.overrides.context_window ?? 200000;
      model.default_reasoning_level =
        route.model.overrides.default_reasoning_level ??
        (route.anthropic?.thinking === "disabled" ? "none" : "medium");
      model.supported_reasoning_levels =
        route.model.overrides.supported_reasoning_levels ??
        (route.anthropic?.thinking === "disabled"
          ? ["none"]
          : [
              ...(route.anthropic?.thinking_required ? [] : ["none"]),
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]
        ).map((effort) => ({
          effort,
          description: effort === "none" ? "Disable thinking" : `${effort} reasoning effort`,
        }));
    }
    delete model.upgrade;
    return model;
  });

  const combined = prependModels({ ...response, models: upstreamModels }, advertisedModels);
  const routeBySlug = new Map(modelRoutes.map((route) => [route.model.slug, route]));
  return {
    ...combined,
    models: combined.models.map((model) => {
      const adjustment = adjustments.find((item) => item.slug === model.slug);
      const adjusted =
        adjustment === undefined
          ? model
          : (deepMerge(model, adjustment.overrides) as ModelDefinition);
      const route = routeBySlug.get(model.slug);
      return route === undefined ? adjusted : gateModelCapabilities(adjusted, route);
    }),
  };
}

export interface TransformModelsResponseOptions {
  routes?: readonly ModelRoute[];
  adjustments?: readonly ModelAdjustment[];
  fixture?: ModelsFixtureOptions;
  observe?: (body: unknown) => Promise<void> | void;
  applyTransformations?: (models: ModelDefinition[]) => ModelDefinition[];
}

export async function transformModelsResponse(
  response: Response,
  options: TransformModelsResponseOptions = {},
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const routes = options.routes ?? [];
  const adjustments = options.adjustments ?? [];
  const observe = options.observe;
  const applyTransformations = options.applyTransformations;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const passthrough = () =>
    new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  const hasListTransforms =
    routes.length > 0 || adjustments.length > 0 || (options.fixture?.pins?.length ?? 0) > 0;
  let body: unknown;
  try {
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    body = JSON.parse(new TextDecoder().decode(await decodeBody(bytes, contentEncoding)));
  } catch {
    // Not decodable JSON; only fail when list transforms were requested.
    return hasListTransforms
      ? new Response("Could not advertise routed models: upstream response is not decodable JSON", {
          status: 502,
        })
      : passthrough();
  }
  try {
    await observe?.(body);
  } catch {
    // observation is best-effort
  }
  let transformed: unknown = body;
  if (hasListTransforms) {
    try {
      transformed = transformModels(body, routes, adjustments, options.fixture);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return new Response(`Could not advertise routed models: ${detail}`, { status: 502 });
    }
  }
  if (applyTransformations !== undefined) {
    const models = modelsArrayOf(transformed);
    if (models === undefined) {
      if (!hasListTransforms) return passthrough();
    } else {
      const next = applyTransformations(models);
      if (next !== models) {
        transformed = { ...(transformed as Record<string, unknown>), models: next };
      } else if (!hasListTransforms) {
        // String transformations matched nothing; preserve the raw response.
        return passthrough();
      }
    }
  } else if (!hasListTransforms) {
    return passthrough();
  }
  if (routes.length > 0) {
    const models = modelsArrayOf(transformed);
    if (models !== undefined) {
      const routeBySlug = new Map(routes.map((route) => [route.model.slug, route]));
      transformed = {
        ...(transformed as Record<string, unknown>),
        models: models.map((model) => {
          const route = routeBySlug.get(model.slug);
          return route === undefined ? model : gateModelCapabilities(model, route);
        }),
      };
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  return Response.json(transformed, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function gateModelCapabilities(model: ModelDefinition, route: ModelRoute): ModelDefinition {
  return {
    ...model,
    ...(route.toolPolicy.tool_search === "reject" ? { supports_search_tool: false } : {}),
    ...(route.toolPolicy.custom === "reject"
      ? { apply_patch_tool_type: null, tool_mode: "direct" }
      : {}),
  };
}

function modelsArrayOf(body: unknown): ModelDefinition[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.models)) return undefined;
  return body.models.every((model) => isRecord(model) && typeof model.slug === "string")
    ? (body.models as ModelDefinition[])
    : undefined;
}

export function deepMerge(base: unknown, overrides: unknown): unknown {
  if (!isRecord(base) || !isRecord(overrides)) {
    return overrides;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

export async function decodeBody(body: Uint8Array, contentEncoding: string): Promise<Uint8Array> {
  if (contentEncoding === "identity" || contentEncoding.length === 0) {
    return body;
  }
  if (contentEncoding === "zstd") {
    return new Uint8Array(await Bun.zstdDecompress(body));
  }
  if (contentEncoding === "br" || contentEncoding === "deflate" || contentEncoding === "gzip") {
    const stream = new Blob([body.buffer as ArrayBuffer])
      .stream()
      .pipeThrough(
        new DecompressionStream(
          contentEncoding as ConstructorParameters<typeof DecompressionStream>[0],
        ),
      );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`unsupported Content-Encoding: ${contentEncoding}`);
}

function prependModels(response: unknown, localModels: readonly ModelDefinition[]): ModelsResponse {
  if (!isRecord(response)) {
    throw new Error("upstream /models response must be a JSON object");
  }
  const upstreamModels = modelDefinitions(response.models, "upstream /models response.models");
  const seenSlugs = new Set<string>();
  const models = [...localModels, ...upstreamModels].filter((model) => {
    if (seenSlugs.has(model.slug)) {
      return false;
    }
    seenSlugs.add(model.slug);
    return true;
  });

  return { ...response, models };
}

function modelDefinitions(value: unknown, source: string): ModelDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be a JSON array`);
  }
  return value.map((model, index) => parseModelDefinition(model, `${source}[${index}]`));
}

function parseModelDefinition(value: unknown, source: string): ModelDefinition {
  if (!isRecord(value) || typeof value.slug !== "string" || value.slug.length === 0) {
    throw new Error(`${source} must be an object with a non-empty string slug`);
  }
  return value as ModelDefinition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { ModelAdjustment, ModelRoute } from "./model-routes.ts";

export type ModelDefinition = Record<string, unknown> & { slug: string };

type ModelsResponse = Record<string, unknown> & { models: ModelDefinition[] };

export function transformModels(
  response: unknown,
  modelRoutes: readonly ModelRoute[],
  adjustments: readonly ModelAdjustment[] = [],
): ModelsResponse {
  if (!isRecord(response)) {
    throw new Error("upstream /models response must be a JSON object");
  }

  const upstreamModels = modelDefinitions(response.models, "upstream /models response.models");
  const templates = new Map(upstreamModels.map((model) => [model.slug, model]));
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
    delete model.upgrade;
    return model;
  });

  const combined = prependModels({ ...response, models: upstreamModels }, advertisedModels);
  if (adjustments.length === 0) return combined;
  return {
    ...combined,
    models: combined.models.map((model) => {
      const adjustment = adjustments.find((item) => item.slug === model.slug);
      return adjustment === undefined
        ? model
        : (deepMerge(model, adjustment.overrides) as ModelDefinition);
    }),
  };
}

export async function transformModelsResponse(
  response: Response,
  routes: readonly ModelRoute[],
  adjustments: readonly ModelAdjustment[] = [],
  observe?: (body: unknown) => Promise<void> | void,
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const passthrough = () =>
    new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  const hasTransforms = routes.length > 0 || adjustments.length > 0;
  let body: unknown;
  try {
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    body = JSON.parse(new TextDecoder().decode(await decodeBody(bytes, contentEncoding)));
  } catch {
    // Not decodable JSON; only fail when transforms were requested.
    return hasTransforms
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
  if (!hasTransforms) {
    return passthrough();
  }
  try {
    const transformed = transformModels(body, routes, adjustments);
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("etag");
    return Response.json(transformed, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return new Response(`Could not advertise routed models: ${detail}`, { status: 502 });
  }
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

export type ModelOverrides = Readonly<Record<string, unknown>>;
type Environment = Readonly<Record<string, string | undefined>>;

const PROTECTED_MODEL_OVERRIDE_FIELDS = new Set([
  "description",
  "display_name",
  "priority",
  "slug",
  "upgrade",
]);

export interface AdvertisedModelConfig {
  description: string;
  display_name: string;
  overrides?: ModelOverrides;
  priority: number;
  slug: string;
  template_slug: string;
}

export interface ModelRouteConfig {
  authorization_env: string;
  enabled?: boolean;
  model: AdvertisedModelConfig;
  upstream: string;
  upstream_model?: string;
}

export interface ModelAdjustment {
  slug: string;
  overrides: Record<string, unknown>;
}

export interface ModelRouteSetData {
  routes: ModelRouteConfig[];
  adjustments: ModelAdjustment[];
}

export interface AdvertisedModel {
  description: string;
  displayName: string;
  overrides: ModelOverrides;
  priority: number;
  slug: string;
  templateSlug: string;
}

export interface ModelRoute {
  authorizationEnv: string;
  enabled: boolean;
  model: AdvertisedModel;
  upstream: URL;
  upstreamModel?: string;
}

export class RouteUnavailable extends Error {}

export function parseModelRouteSet(value: unknown): ModelRouteSetData {
  const set = routeSetValue(value);
  return {
    routes: set.routes.map((route, index) => routeConfig(route, `route[${index}]`)),
    adjustments: set.adjustments.map((adjustment, index) =>
      adjustmentConfig(adjustment, `adjustment[${index}]`),
    ),
  };
}

export function modelRouteFromConfig(config: ModelRouteConfig): ModelRoute {
  return {
    authorizationEnv: config.authorization_env,
    enabled: config.enabled ?? true,
    model: {
      description: config.model.description,
      displayName: config.model.display_name,
      overrides: config.model.overrides ?? {},
      priority: config.model.priority,
      slug: config.model.slug,
      templateSlug: config.model.template_slug,
    },
    upstream: new URL(config.upstream),
    ...(config.upstream_model === undefined ? {} : { upstreamModel: config.upstream_model }),
  };
}

export function authorizationFor(route: ModelRoute, env: Environment): string {
  const token = env[route.authorizationEnv];
  if (token === undefined || token.length === 0) {
    throw new RouteUnavailable(
      `model route ${route.model.slug} requires unset authorization env: ${route.authorizationEnv}`,
    );
  }
  return `Bearer ${token}`;
}

export function modelRouteFor(
  routes: readonly ModelRoute[],
  model: string,
): ModelRoute | undefined {
  return routes.find((route) => route.enabled && route.model.slug === model);
}

export function responseTargetUrl(route: ModelRoute, search: string): URL {
  const target = new URL(route.upstream);
  const basePath = target.pathname.replace(/\/$/, "");
  target.pathname = `${basePath}/responses`;
  target.search = search;
  return target;
}

export function routedHeaders(
  headers: Record<string, string>,
  authorization: string,
): Record<string, string> {
  const routed = { ...headers };
  delete routed.authorization;
  delete routed["chatgpt-account-id"];
  delete routed["content-encoding"];
  delete routed["content-length"];
  delete routed.cookie;
  routed.authorization = authorization;
  return routed;
}

export function inspectResponseModel(
  value: string | ArrayBuffer | Uint8Array,
): { payload: Record<string, unknown>; model: string } | undefined {
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.model === "string") {
      return { payload: parsed, model: parsed.model };
    }
  } catch {
    // not a JSON payload; leave unrouted
  }
  return undefined;
}

function routeSetValue(value: unknown): { routes: unknown[]; adjustments: unknown[] } {
  if (Array.isArray(value)) return { routes: value, adjustments: [] };
  const set = objectValue(value);
  if (set?.version === 1 && Array.isArray(set.routes)) {
    if (set.adjustments !== undefined && !Array.isArray(set.adjustments)) {
      throw new Error("model route set adjustments must be an array");
    }
    return { routes: set.routes, adjustments: set.adjustments ?? [] };
  }
  throw new Error("unsupported model route set");
}

function adjustmentConfig(value: unknown, source: string): ModelAdjustment {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  const overrides = value.overrides === undefined ? {} : value.overrides;
  if (!isRecord(overrides)) {
    throw new Error(`${source}.overrides must be an object`);
  }
  if (Object.hasOwn(overrides, "slug")) {
    throw new Error(`${source}.overrides.slug is not allowed`);
  }
  return { slug: nonEmptyString(value.slug, `${source}.slug`), overrides };
}

function routeConfig(value: unknown, source: string): ModelRouteConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`${source}.enabled must be a boolean`);
  }
  return {
    authorization_env: nonEmptyString(value.authorization_env, `${source}.authorization_env`),
    ...(enabled === undefined ? {} : { enabled }),
    model: advertisedModelConfig(value.model, `${source}.model`),
    upstream: upstreamString(value.upstream, `${source}.upstream`),
    upstream_model:
      value.upstream_model === undefined
        ? undefined
        : nonEmptyString(value.upstream_model, `${source}.upstream_model`),
  };
}

function advertisedModelConfig(value: unknown, source: string): AdvertisedModelConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) {
    throw new Error(`${source}.priority must be a finite number`);
  }
  return {
    description: nonEmptyString(value.description, `${source}.description`),
    display_name: nonEmptyString(value.display_name, `${source}.display_name`),
    overrides: modelOverrides(value.overrides, `${source}.overrides`),
    priority: value.priority,
    slug: nonEmptyString(value.slug, `${source}.slug`),
    template_slug: nonEmptyString(value.template_slug, `${source}.template_slug`),
  };
}

function modelOverrides(value: unknown, source: string): ModelOverrides | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (PROTECTED_MODEL_OVERRIDE_FIELDS.has(field)) {
      throw new Error(`${source}.${field} is not allowed`);
    }
  }
  return value;
}

function upstreamString(value: unknown, source: string): string {
  const upstream = nonEmptyString(value, source);
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    throw new Error(`${source} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${source} must use http or https`);
  }
  return upstream;
}

function nonEmptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

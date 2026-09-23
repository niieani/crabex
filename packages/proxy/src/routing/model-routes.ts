import {
  effectiveToolPolicy,
  parseToolConfiguration,
  type ToolPolicy,
  type ToolPolicyConfig,
} from "./tool-policy.ts";

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
  /** Exact, single-occurrence edits to the template model's instructions. */
  template_replacements?: { find: string; replace: string }[];
}

export interface RouteTargetConfig {
  /** Model name sent to the upstream; defaults to the advertised slug. */
  upstream_model?: string;
  /** Attempts for this target before moving to the next one; default 1. */
  attempts?: number;
}

export interface RouteBreakerConfig {
  /** Consecutive exhausted-target episodes before the breaker opens; default 3. */
  failures?: number;
  /** How long an open breaker skips the target, in ms; default 60000. */
  cooldown_ms?: number;
}

export interface RouteRetryConfig {
  /** Statuses worth retrying on the same target; default [429, 500, 502, 503, 504]. */
  on_status?: number[];
  /** Backoff between attempts in ms; the last value repeats; default [250, 1000]. */
  backoff_ms?: number[];
  breaker?: RouteBreakerConfig;
}

export interface AnthropicOptions {
  /** Includes thinking and visible output. */
  max_tokens?: number;
  thinking?: "adaptive" | "budget" | "disabled";
  thinking_required?: boolean;
  drop_mismatched_thinking?: boolean;
  budget_tokens?: number;
  auth?: "bearer" | "api-key";
  cache_prompt?: boolean;
  beta?: string[];
}

export interface ModelRouteConfig {
  api?: "responses" | "anthropic-messages";
  anthropic?: AnthropicOptions;
  authorization_env: string;
  enabled?: boolean;
  model: AdvertisedModelConfig;
  upstream: string;
  upstream_model?: string;
  /** Ordered failover targets; mutually exclusive with upstream_model. */
  targets?: RouteTargetConfig[];
  retry?: RouteRetryConfig;
  /** Upstream transport; default "ws" (Responses-over-WebSocket). */
  transport?: "http" | "ws";
  /** Keep upstream response IDs so the HTTP bridge can continue stored responses. */
  bridge_response_state?: "replay" | "stored";
  /** Per-type route behavior. Omitted entries use the provider defaults. */
  tool_policy?: ToolPolicyConfig;
  /** @deprecated Use tool_policy. Listed types use provider defaults; others are omitted. */
  allowed_tool_types?: string[];
  /**
   * Forward ChatGPT `access_programs` to this upstream. Default false — custom
   * API-key gateways reject the field unless the org has it enabled.
   */
  forward_access_programs?: boolean;
}

export interface ModelAdjustment {
  slug: string;
  overrides: Record<string, unknown>;
}

export interface ModelRouteSetData {
  routes: ModelRouteConfig[];
  adjustments: ModelAdjustment[];
  /** Slugs served from the baked-in fixture instead of the fetched upstream list. */
  fixture_pins: string[];
}

export interface AdvertisedModel {
  description: string;
  displayName: string;
  overrides: ModelOverrides;
  priority: number;
  slug: string;
  templateSlug: string;
  templateReplacements: readonly { find: string; replace: string }[];
}

export interface RouteTarget {
  upstreamModel?: string;
  attempts: number;
}

export interface RouteRetryPolicy {
  onStatus: number[];
  backoffMs: number[];
  breaker: { failures: number; cooldownMs: number };
}

export const DEFAULT_RETRY_ON_STATUS = [429, 500, 502, 503, 504];
export const DEFAULT_RETRY_BACKOFF_MS = [250, 1000];
export const DEFAULT_BREAKER = { failures: 3, cooldownMs: 60_000 };

export interface ModelRoute {
  api?: "responses" | "anthropic-messages";
  anthropic?: AnthropicOptions;
  authorizationEnv: string;
  enabled: boolean;
  model: AdvertisedModel;
  upstream: URL;
  upstreamModel?: string;
  targets: RouteTarget[];
  retry: RouteRetryPolicy;
  transport: "http" | "ws";
  bridgeResponseState: "replay" | "stored";
  toolPolicy: ToolPolicy;
  forwardAccessPrograms: boolean;
}

export class RouteUnavailable extends Error {}

export function parseModelRouteSet(value: unknown): ModelRouteSetData {
  const set = routeSetValue(value);
  return {
    routes: set.routes.map((route, index) => routeConfig(route, `route[${index}]`)),
    adjustments: set.adjustments.map((adjustment, index) =>
      adjustmentConfig(adjustment, `adjustment[${index}]`),
    ),
    fixture_pins: set.fixturePins.map((pin, index) =>
      nonEmptyString(pin, `fixture_pins[${index}]`),
    ),
  };
}

export function modelRouteFromConfig(config: ModelRouteConfig): ModelRoute {
  const transport = config.transport ?? (config.api === "anthropic-messages" ? "http" : "ws");
  const toolPolicy = effectiveToolPolicy(config);
  requireResponsesTranslationBridge(
    toolPolicy.custom,
    transport,
    "model route.tool_policy.custom",
    config.api ?? "responses",
  );
  requireResponsesTranslationBridge(
    toolPolicy.tool_search,
    transport,
    "model route.tool_policy.tool_search",
    config.api ?? "responses",
  );
  return {
    authorizationEnv: config.authorization_env,
    ...(config.api === undefined ? {} : { api: config.api }),
    ...(config.anthropic === undefined ? {} : { anthropic: config.anthropic }),
    enabled: config.enabled ?? true,
    model: {
      description: config.model.description,
      displayName: config.model.display_name,
      overrides: config.model.overrides ?? {},
      priority: config.model.priority,
      slug: config.model.slug,
      templateSlug: config.model.template_slug,
      templateReplacements: config.model.template_replacements ?? [],
    },
    upstream: new URL(config.upstream),
    ...(config.upstream_model === undefined ? {} : { upstreamModel: config.upstream_model }),
    targets: (config.targets ?? [{ upstream_model: config.upstream_model }]).map((target) => ({
      ...(target.upstream_model === undefined ? {} : { upstreamModel: target.upstream_model }),
      attempts: target.attempts ?? 1,
    })),
    retry: {
      onStatus: config.retry?.on_status ?? [...DEFAULT_RETRY_ON_STATUS],
      backoffMs: config.retry?.backoff_ms ?? [...DEFAULT_RETRY_BACKOFF_MS],
      breaker: {
        failures: config.retry?.breaker?.failures ?? DEFAULT_BREAKER.failures,
        cooldownMs: config.retry?.breaker?.cooldown_ms ?? DEFAULT_BREAKER.cooldownMs,
      },
    },
    transport,
    bridgeResponseState: config.bridge_response_state ?? "replay",
    toolPolicy,
    forwardAccessPrograms: config.forward_access_programs === true,
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
  target.pathname =
    route.api === "anthropic-messages"
      ? basePath.endsWith("/v1/messages")
        ? basePath
        : basePath.endsWith("/v1")
          ? `${basePath}/messages`
          : `${basePath}/v1/messages`
      : `${basePath}/responses`;
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

function routeSetValue(value: unknown): {
  routes: unknown[];
  adjustments: unknown[];
  fixturePins: unknown[];
} {
  if (Array.isArray(value)) return { routes: value, adjustments: [], fixturePins: [] };
  const set = objectValue(value);
  if (set?.version === 1 && Array.isArray(set.routes)) {
    if (set.adjustments !== undefined && !Array.isArray(set.adjustments)) {
      throw new Error("model route set adjustments must be an array");
    }
    if (set.fixture_pins !== undefined && !Array.isArray(set.fixture_pins)) {
      throw new Error("model route set fixture_pins must be an array");
    }
    return {
      routes: set.routes,
      adjustments: set.adjustments ?? [],
      fixturePins: set.fixture_pins ?? [],
    };
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
  const api = value.api;
  if (api !== undefined && api !== "responses" && api !== "anthropic-messages") {
    throw new Error(`${source}.api must be responses or anthropic-messages`);
  }
  const anthropic =
    value.anthropic === undefined ? undefined : anthropicOptions(value.anthropic, source);
  if (anthropic !== undefined && api !== "anthropic-messages")
    throw new Error(`${source}.anthropic requires anthropic-messages api`);
  if (
    api === "anthropic-messages" &&
    (value.transport === "ws" || value.bridge_response_state === "stored")
  ) {
    throw new Error(`${source}: Anthropic requires HTTP transport and replay response state`);
  }
  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`${source}.enabled must be a boolean`);
  }
  if (value.upstream_model !== undefined && value.targets !== undefined) {
    throw new Error(`${source} cannot set both upstream_model and targets`);
  }
  const transport = value.transport;
  if (transport !== undefined && transport !== "http" && transport !== "ws") {
    throw new Error(`${source}.transport must be "http" or "ws"`);
  }
  const bridgeResponseState = value.bridge_response_state;
  if (
    bridgeResponseState !== undefined &&
    bridgeResponseState !== "replay" &&
    bridgeResponseState !== "stored"
  ) {
    throw new Error(`${source}.bridge_response_state must be "replay" or "stored"`);
  }
  if (bridgeResponseState === "stored" && transport !== "http") {
    throw new Error(`${source}.bridge_response_state "stored" requires http transport`);
  }
  if (
    bridgeResponseState === "stored" &&
    Array.isArray(value.targets) &&
    value.targets.length !== 1
  ) {
    throw new Error(`${source}.bridge_response_state "stored" requires one target`);
  }
  const toolConfiguration = parseToolConfiguration(
    value.tool_policy,
    value.allowed_tool_types,
    api ?? "responses",
    source,
  );
  requireResponsesTranslationBridge(
    toolConfiguration.tool_policy?.custom,
    transport ?? (api === "anthropic-messages" ? "http" : "ws"),
    `${source}.tool_policy.custom`,
    api ?? "responses",
  );
  requireResponsesTranslationBridge(
    toolConfiguration.tool_policy?.tool_search,
    transport ?? (api === "anthropic-messages" ? "http" : "ws"),
    `${source}.tool_policy.tool_search`,
    api ?? "responses",
  );
  const forwardAccessPrograms = value.forward_access_programs;
  if (forwardAccessPrograms !== undefined && typeof forwardAccessPrograms !== "boolean") {
    throw new Error(`${source}.forward_access_programs must be a boolean`);
  }
  return {
    ...(api === undefined ? {} : { api }),
    ...(anthropic === undefined ? {} : { anthropic }),
    authorization_env: nonEmptyString(value.authorization_env, `${source}.authorization_env`),
    ...(enabled === undefined ? {} : { enabled }),
    model: advertisedModelConfig(value.model, `${source}.model`),
    upstream: upstreamString(value.upstream, `${source}.upstream`),
    upstream_model:
      value.upstream_model === undefined
        ? undefined
        : nonEmptyString(value.upstream_model, `${source}.upstream_model`),
    ...(value.targets === undefined
      ? {}
      : { targets: targetsConfig(value.targets, `${source}.targets`) }),
    ...(value.retry === undefined ? {} : { retry: retryConfig(value.retry, `${source}.retry`) }),
    ...(transport === undefined ? {} : { transport }),
    ...(bridgeResponseState === undefined ? {} : { bridge_response_state: bridgeResponseState }),
    ...toolConfiguration,
    ...(forwardAccessPrograms === undefined
      ? {}
      : { forward_access_programs: forwardAccessPrograms }),
  };
}

function requireResponsesTranslationBridge(
  action: string | undefined,
  transport: "http" | "ws",
  source: string,
  api: "responses" | "anthropic-messages" = "responses",
): void {
  if (api === "responses" && action === "translate" && transport !== "http") {
    throw new Error(`${source} action "translate" requires http transport`);
  }
}

function targetsConfig(value: unknown, source: string): RouteTargetConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} must be a non-empty array`);
  }
  return value.map((target, index) => {
    const targetSource = `${source}[${index}]`;
    if (!isRecord(target)) {
      throw new Error(`${targetSource} must be an object`);
    }
    const attempts = target.attempts;
    if (
      attempts !== undefined &&
      (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1)
    ) {
      throw new Error(`${targetSource}.attempts must be a positive integer`);
    }
    return {
      ...(target.upstream_model === undefined
        ? {}
        : {
            upstream_model: nonEmptyString(target.upstream_model, `${targetSource}.upstream_model`),
          }),
      ...(attempts === undefined ? {} : { attempts }),
    };
  });
}

function retryConfig(value: unknown, source: string): RouteRetryConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  const onStatus = value.on_status;
  if (
    onStatus !== undefined &&
    (!Array.isArray(onStatus) ||
      onStatus.some(
        (status) =>
          typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599,
      ))
  ) {
    throw new Error(`${source}.on_status must be an array of HTTP status codes`);
  }
  const backoffMs = value.backoff_ms;
  if (
    backoffMs !== undefined &&
    (!Array.isArray(backoffMs) ||
      backoffMs.length === 0 ||
      backoffMs.some((ms) => typeof ms !== "number" || ms < 0))
  ) {
    throw new Error(`${source}.backoff_ms must be a non-empty array of non-negative numbers`);
  }
  const breaker = value.breaker;
  if (breaker !== undefined && !isRecord(breaker)) {
    throw new Error(`${source}.breaker must be an object`);
  }
  const failures = breaker?.failures;
  if (
    failures !== undefined &&
    (typeof failures !== "number" || !Number.isInteger(failures) || failures < 1)
  ) {
    throw new Error(`${source}.breaker.failures must be a positive integer`);
  }
  const cooldownMs = breaker?.cooldown_ms;
  if (cooldownMs !== undefined && (typeof cooldownMs !== "number" || cooldownMs < 0)) {
    throw new Error(`${source}.breaker.cooldown_ms must be a non-negative number`);
  }
  return {
    ...(onStatus === undefined ? {} : { on_status: onStatus }),
    ...(backoffMs === undefined ? {} : { backoff_ms: backoffMs }),
    ...(breaker === undefined
      ? {}
      : {
          breaker: {
            ...(failures === undefined ? {} : { failures }),
            ...(cooldownMs === undefined ? {} : { cooldown_ms: cooldownMs }),
          },
        }),
  };
}

function advertisedModelConfig(value: unknown, source: string): AdvertisedModelConfig {
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) {
    throw new Error(`${source}.priority must be a finite number`);
  }
  const templateReplacements = value.template_replacements;
  if (
    templateReplacements !== undefined &&
    (!Array.isArray(templateReplacements) ||
      templateReplacements.some(
        (replacement) =>
          !isRecord(replacement) ||
          typeof replacement.find !== "string" ||
          replacement.find.length === 0 ||
          typeof replacement.replace !== "string",
      ))
  ) {
    throw new Error(`${source}.template_replacements must contain find/replace strings`);
  }
  return {
    description: nonEmptyString(value.description, `${source}.description`),
    display_name: nonEmptyString(value.display_name, `${source}.display_name`),
    overrides: modelOverrides(value.overrides, `${source}.overrides`),
    priority: value.priority,
    slug: nonEmptyString(value.slug, `${source}.slug`),
    template_slug: nonEmptyString(value.template_slug, `${source}.template_slug`),
    ...(templateReplacements === undefined ? {} : { template_replacements: templateReplacements }),
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

function anthropicOptions(value: unknown, source: string): AnthropicOptions {
  if (!isRecord(value)) throw new Error(`${source}.anthropic must be an object`);
  const allowed = new Set([
    "max_tokens",
    "thinking",
    "thinking_required",
    "drop_mismatched_thinking",
    "budget_tokens",
    "auth",
    "cache_prompt",
    "beta",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${source}.anthropic.${key} is unknown`);
  for (const key of ["max_tokens", "budget_tokens"]) {
    const n = value[key];
    if (
      n !== undefined &&
      (typeof n !== "number" ||
        !Number.isSafeInteger(n) ||
        n < (key === "budget_tokens" ? 1024 : 1))
    )
      throw new Error(`${source}.anthropic.${key} is invalid`);
  }
  if (
    value.thinking !== undefined &&
    (typeof value.thinking !== "string" ||
      !["adaptive", "budget", "disabled"].includes(value.thinking))
  )
    throw new Error(`${source}.anthropic.thinking is invalid`);
  for (const field of ["thinking_required", "drop_mismatched_thinking"])
    if (value[field] !== undefined && typeof value[field] !== "boolean")
      throw new Error(`${source}.anthropic.${field} must be boolean`);
  if (value.thinking_required && value.thinking !== undefined && value.thinking !== "adaptive")
    throw new Error(`${source}.anthropic.thinking_required requires adaptive thinking`);
  if (value.auth !== undefined && value.auth !== "bearer" && value.auth !== "api-key")
    throw new Error(`${source}.anthropic.auth is invalid`);
  if (value.cache_prompt !== undefined && typeof value.cache_prompt !== "boolean")
    throw new Error(`${source}.anthropic.cache_prompt must be boolean`);
  if (
    value.beta !== undefined &&
    (!Array.isArray(value.beta) ||
      value.beta.some((v) => typeof v !== "string" || !/^[a-zA-Z0-9-]+$/.test(v)))
  )
    throw new Error(`${source}.anthropic.beta is invalid`);
  if (
    typeof value.budget_tokens === "number" &&
    value.budget_tokens >= Number(value.max_tokens ?? 32768)
  )
    throw new Error(`${source}.anthropic.budget_tokens must be less than max_tokens`);
  return value as AnthropicOptions;
}

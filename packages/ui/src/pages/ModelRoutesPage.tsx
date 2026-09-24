import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { RouteCapabilities } from "../features/routes/RouteCapabilities.tsx";
import { RouteProxySettings } from "../features/routes/RouteProxySettings.tsx";
import {
  getModelRouteEnvStatus,
  getModelRoutes,
  getModelsFixture,
  getProxyConfig,
  getRoutingTelemetry,
  getUpstreamCache,
  putModelRoutes,
  resetStats,
} from "../lib/api.ts";
import type {
  ModelAdjustment,
  ModelDefinition,
  ModelRouteConfig,
  ModelRouteSet,
  RoutingTelemetry,
} from "../lib/types.ts";

export function ModelRoutesPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["model-routes"], queryFn: getModelRoutes });
  const envQuery = useQuery({ queryKey: ["model-route-env"], queryFn: getModelRouteEnvStatus });
  const proxyQuery = useQuery({ queryKey: ["proxy-config"], queryFn: getProxyConfig });
  const telemetryQuery = useQuery({
    queryKey: ["routing-telemetry"],
    queryFn: getRoutingTelemetry,
    refetchInterval: 5000,
  });
  const telemetry = telemetryQuery.data?.telemetry ?? [];
  const openBreakers = telemetryQuery.data?.breakers ?? {};
  const upstreamQuery = useQuery({
    queryKey: ["upstream-cache"],
    queryFn: getUpstreamCache,
    refetchInterval: 5000,
  });
  const upstreamModels = modelDefinitions(upstreamQuery.data?.models?.body);
  const upstreamFetchedAt = upstreamQuery.data?.models?.fetchedAt;
  const fixtureQuery = useQuery({ queryKey: ["models-fixture"], queryFn: getModelsFixture });
  const fixtureModels = fixtureQuery.data?.models ?? [];
  const fixtureBySlug = new Map(fixtureModels.map((model) => [model.slug, model]));
  const fixtureOnlyModels = fixtureModels.filter(
    (model) => !upstreamModels.some((upstream) => upstream.slug === model.slug),
  );
  const mutation = useMutation({
    mutationFn: putModelRoutes,
    onSuccess: (set) => {
      queryClient.setQueryData(["model-routes"], set);
      void queryClient.invalidateQueries({ queryKey: ["model-route-env"] });
    },
  });
  const resetMutation = useMutation({
    mutationFn: resetStats,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["routing-telemetry"] });
      void queryClient.invalidateQueries({ queryKey: ["transformation-telemetry"] });
    },
  });
  const set = query.data;

  if (query.isPending)
    return <EmptyState title="Loading model routes" detail="Reading the local route set…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  if (set === undefined) return null;

  const replace = (next: ModelRouteSet) => mutation.mutate(next);
  const add = (route: ModelRouteConfig) => replace({ ...set, routes: [...set.routes, route] });
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (mutation.isPending || destination < 0 || destination >= set.routes.length) return;
    const routes = [...set.routes];
    [routes[index], routes[destination]] = [routes[destination]!, routes[index]!];
    replace({
      ...set,
      routes: routes.map((route, position) => ({
        ...route,
        model: { ...route.model, priority: position + 1 },
      })),
    });
  };
  const saveAdjustment = (adjustment: ModelAdjustment) =>
    replace({
      ...set,
      adjustments: [
        ...(set.adjustments ?? []).filter((item) => item.slug !== adjustment.slug),
        adjustment,
      ],
    });
  const removeAdjustment = (slug: string) =>
    replace({
      ...set,
      adjustments: (set.adjustments ?? []).filter((item) => item.slug !== slug),
    });
  const togglePin = (slug: string) =>
    replace({
      ...set,
      fixture_pins: (set.fixture_pins ?? []).includes(slug)
        ? (set.fixture_pins ?? []).filter((pin) => pin !== slug)
        : [...(set.fixture_pins ?? []), slug],
    });

  return (
    <div className="management-layout">
      <section className="border-r border-line p-6 lg:min-h-0 lg:overflow-y-auto lg:p-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="section-label">Alternate upstreams</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Model routes</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={resetMutation.isPending}
              onClick={() => resetMutation.mutate()}
              title="Reset persisted transformation and routing counters"
              className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:bg-danger-dim hover:text-danger disabled:opacity-50"
            >
              {resetMutation.isPending ? "Resetting…" : "Reset counters"}
            </button>
            <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
              {set.routes.length} routes
            </span>
          </div>
        </div>
        {mutation.isError ? (
          <p className="mb-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            {mutation.error.message}
          </p>
        ) : null}
        <RouteProxySettings routes={set.routes} />
        <div className="space-y-2">
          {set.routes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
              No model routes yet.
            </div>
          ) : (
            set.routes.map((route, index) => (
              <RouteCard
                key={route.model.slug}
                route={route}
                pending={mutation.isPending}
                canMoveUp={index > 0}
                canMoveDown={index < set.routes.length - 1}
                onMoveUp={() => move(index, -1)}
                onMoveDown={() => move(index, 1)}
                envSet={envQuery.data?.[route.authorization_env]}
                routes={set.routes}
                defaultBroker={proxyQuery.data?.search_broker.route ?? "gpt-6-luna"}
                breakerUntil={breakerUntilFor(route, openBreakers)}
                telemetry={telemetry.find(
                  (entry) => entry.action === "routed" && entry.routeSlug === route.model.slug,
                )}
                onToggle={() =>
                  replace(updateRoute(set, index, { ...route, enabled: !(route.enabled ?? true) }))
                }
                onUpdate={(next) => replace(updateRoute(set, index, next))}
                onDelete={() =>
                  replace({ ...set, routes: set.routes.filter((_, i) => i !== index) })
                }
              />
            ))
          )}
        </div>
        <div className="mt-8">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="section-label">Observed upstream</p>
              <h2 className="mt-2 text-lg font-semibold tracking-tight">Upstream models</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
                The last model list returned by the real upstream. Adjustments deep-merge into the
                advertised fields — for example context_window or
                model_messages.instructions_template — before the list reaches Codex.
              </p>
            </div>
            {upstreamFetchedAt === undefined ? null : (
              <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
                fetched {new Date(upstreamFetchedAt).toLocaleString()}
              </span>
            )}
          </div>
          {upstreamModels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
              No upstream model list observed yet. It is recorded the next time Codex fetches
              /models through the proxy.
            </div>
          ) : (
            <div className="space-y-2">
              {upstreamModels.map((model) => (
                <UpstreamModelCard
                  key={model.slug}
                  model={model}
                  fixtureModel={fixtureBySlug.get(model.slug)}
                  pinned={(set.fixture_pins ?? []).includes(model.slug)}
                  onTogglePin={() => togglePin(model.slug)}
                  adjustment={(set.adjustments ?? []).find((item) => item.slug === model.slug)}
                  onSave={saveAdjustment}
                  onRemove={removeAdjustment}
                  pending={mutation.isPending}
                />
              ))}
            </div>
          )}
          {fixtureOnlyModels.length === 0 ? null : (
            <div className="mt-6">
              <p className="section-label">Baked-in fixture</p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
                Models packaged with the proxy that the upstream did not advertise. They are not
                served directly, but any of their slugs can be used as a route template.
              </p>
              <div className="mt-3 space-y-2">
                {fixtureOnlyModels.map((model) => (
                  <article
                    key={model.slug}
                    className="rounded-xl border border-line/60 bg-panel/40 p-4"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <h3 className="truncate text-sm font-semibold">
                        {typeof model.display_name === "string" ? model.display_name : model.slug}
                      </h3>
                      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted">
                        <Tag>{model.slug}</Tag>
                        <Tag>fixture only</Tag>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
          {(set.adjustments ?? [])
            .filter((item) => !upstreamModels.some((model) => model.slug === item.slug))
            .map((item) => (
              <p
                key={item.slug}
                className="mt-2 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger"
              >
                Adjustment for {item.slug} matches no observed upstream model.
                <button
                  type="button"
                  onClick={() => removeAdjustment(item.slug)}
                  className="ml-2 underline"
                >
                  Remove
                </button>
              </p>
            ))}
        </div>
      </section>
      <aside className="bg-panel p-5 lg:min-h-0 lg:overflow-y-auto">
        <p className="section-label">New route</p>
        <RouteEditor
          onCreate={add}
          templateSlugs={[
            ...new Set([
              ...upstreamModels.map((model) => model.slug),
              ...fixtureModels.map((model) => model.slug),
            ]),
          ]}
        />
      </aside>
    </div>
  );
}

function breakerUntilFor(
  route: ModelRouteConfig,
  openBreakers: Record<string, string>,
): string | undefined {
  const prefix = `${route.model.slug}::`;
  const untils = Object.entries(openBreakers)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, until]) => until)
    .sort();
  return untils[untils.length - 1];
}

function RouteCard({
  route,
  envSet,
  routes,
  defaultBroker,
  breakerUntil,
  telemetry,
  onToggle,
  onUpdate,
  onDelete,
  pending,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  route: ModelRouteConfig;
  envSet?: boolean;
  routes: ModelRouteConfig[];
  defaultBroker: string;
  breakerUntil?: string;
  telemetry?: RoutingTelemetry;
  onToggle: () => void;
  onUpdate: (route: ModelRouteConfig) => void;
  onDelete: () => void;
  pending: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const enabled = route.enabled ?? true;
  return (
    <article
      className={`rounded-xl border p-4 ${enabled ? "border-line bg-panel" : "border-line/60 bg-panel/40 opacity-60"}`}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4">
            <h2 className="truncate text-sm font-semibold">{route.model.display_name}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={`Move ${route.model.display_name} up`}
                title="Move up"
                disabled={pending || !canMoveUp}
                onClick={onMoveUp}
                className="rounded p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                aria-label={`Move ${route.model.display_name} down`}
                title="Move down"
                disabled={pending || !canMoveDown}
                onClick={onMoveDown}
                className="rounded p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={onToggle}
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"}`}
              >
                {enabled ? "Enabled" : "Disabled"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={onDelete}
                className="rounded px-2 py-1 text-[10px] text-muted hover:bg-danger-dim hover:text-danger"
              >
                Delete
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted">
            <Tag>{route.model.slug}</Tag>
            <Tag>template:{route.model.template_slug}</Tag>
            <Tag>priority:{route.model.priority}</Tag>
            <Tag>{route.upstream}</Tag>
            {route.transport === undefined ? null : <Tag>{route.transport}</Tag>}
            {route.api === "anthropic-messages" ? <Tag>Anthropic Messages</Tag> : null}
            {route.upstream_model === undefined ? null : <Tag>as:{route.upstream_model}</Tag>}
            {(route.targets ?? []).map((target) => (
              <Tag key={target.upstream_model ?? "default"}>
                → {target.upstream_model ?? route.model.slug}
                {(target.attempts ?? 1) > 1 ? ` ×${target.attempts}` : ""}
              </Tag>
            ))}
            <Tag>
              ${route.authorization_env}
              {envSet === undefined ? "" : envSet ? " set" : " missing"}
            </Tag>
          </div>
          {telemetry === undefined ? null : <RouteStats telemetry={telemetry} />}
          {breakerUntil === undefined ? null : (
            <p className="mt-3 rounded-md bg-danger-dim px-3 py-2 text-[10px] text-danger">
              Circuit breaker open until {new Date(breakerUntil).toLocaleTimeString()} — skipping
              the failing target and serving the fallback directly.
            </p>
          )}
          {envSet === false && enabled ? (
            <p className="mt-3 rounded-md bg-danger-dim px-3 py-2 text-[10px] text-danger">
              Environment variable {route.authorization_env} is not set in the proxy process —
              routed requests will fail with 502.
            </p>
          ) : null}
          <p className="mt-3 text-xs leading-5 text-muted">{route.model.description}</p>
          {route.model.overrides === undefined ||
          Object.keys(route.model.overrides).length === 0 ? null : (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
              {JSON.stringify(route.model.overrides, null, 2)}
            </pre>
          )}
          <RouteCapabilities
            route={route}
            routes={routes}
            defaultBroker={defaultBroker}
            pending={pending}
            onUpdate={onUpdate}
          />
        </div>
      </div>
    </article>
  );
}

function RouteStats({ telemetry }: { telemetry: RoutingTelemetry }) {
  const served = telemetry.served ?? 0;
  const errorRate = telemetry.errorRate;
  const targets = Object.entries(telemetry.targets ?? {}).sort(
    (left, right) => right[1].attempts - left[1].attempts,
  );
  const fallbackCacheDropped =
    telemetry.fallbackCache !== undefined &&
    telemetry.fallbackCache.samples > 0 &&
    (telemetry.fallbackCacheHitRate ?? 0) + 20 < (telemetry.cacheHitRate ?? 0);
  return (
    <div className="mt-3 rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-muted">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>routed {telemetry.count}</span>
        <span className="text-accent">served {served}</span>
        {errorRate === undefined ? null : (
          <span className={errorRate > 0 ? "text-danger" : ""}>errors {errorRate}%</span>
        )}
        {(telemetry.failovers ?? 0) === 0 ? null : <span>fallbacks {telemetry.failovers}</span>}
        {telemetry.avgLatencyMs === undefined ? null : (
          <span>avg {formatMs(telemetry.avgLatencyMs)}</span>
        )}
        {cacheLabel(telemetry.cacheHitRate, telemetry.cache)}
        {telemetry.fallbackCache === undefined ? null : (
          <span className={fallbackCacheDropped ? "text-danger" : ""}>
            fallback cache{" "}
            {formatCacheRate(telemetry.fallbackCacheHitRate, telemetry.fallbackCache)}
          </span>
        )}
        <span>last {new Date(telemetry.lastSeenAt).toLocaleString()}</span>
      </div>
      {fallbackCacheDropped ? (
        <p className="mt-1 text-[10px] text-danger">
          Prompt cache looks dropped on tier switch — OpenAI treats a service-tier / model change as
          a cache miss, so fallbacks typically pay uncached input.
        </p>
      ) : null}
      {targets.length === 0 ? null : (
        <div className="mt-2 space-y-1 border-t border-line/60 pt-2">
          {targets.map(([model, stats]) => (
            <div key={model} className="flex flex-wrap gap-x-3 gap-y-1">
              <span className="text-content">→ {model}</span>
              <span>
                served {stats.served}/{stats.attempts}
              </span>
              {stats.errorRate === undefined ? null : (
                <span className={stats.errorRate > 0 ? "text-danger" : ""}>
                  errors {stats.errorRate}%
                </span>
              )}
              {retryLabel(stats)}
              {cacheLabel(stats.cacheHitRate, stats.cache)}
              {stats.avgLatencyMs === undefined ? null : (
                <span>avg {formatMs(stats.avgLatencyMs)}</span>
              )}
              {stats.lastStatus === undefined ? null : (
                <span className={stats.lastStatus >= 400 ? "text-danger" : ""}>
                  last {stats.lastStatus}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function retryLabel(stats: {
  retriedRequests?: number;
  retryRecoveries?: number;
  retrySuccessRate?: number;
}): ReactNode {
  const episodes = stats.retriedRequests ?? 0;
  if (episodes === 0) return null;
  const recovered = stats.retryRecoveries ?? 0;
  return (
    <span>
      retry {recovered}/{episodes}
      {stats.retrySuccessRate === undefined ? "" : ` (${stats.retrySuccessRate}%)`}
    </span>
  );
}

function cacheLabel(
  rate: number | undefined,
  cache: { samples: number; inputTokens: number; cachedTokens: number } | undefined,
): ReactNode {
  if (cache === undefined || cache.samples === 0) return null;
  return <span>cache {formatCacheRate(rate, cache)}</span>;
}

function formatCacheRate(
  rate: number | undefined,
  cache: { inputTokens: number; cachedTokens: number },
): string {
  const pct = rate === undefined ? "—" : `${rate}%`;
  return `${pct} (${formatTokens(cache.cachedTokens)}/${formatTokens(cache.inputTokens)})`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

type UpstreamModel = Record<string, unknown> & { slug: string };

function UpstreamModelCard({
  model,
  fixtureModel,
  pinned,
  onTogglePin,
  adjustment,
  onSave,
  onRemove,
  pending,
}: {
  model: UpstreamModel;
  fixtureModel?: ModelDefinition;
  pinned: boolean;
  onTogglePin: () => void;
  adjustment?: ModelAdjustment;
  onSave: (adjustment: ModelAdjustment) => void;
  onRemove: (slug: string) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const base = pinned && fixtureModel !== undefined ? fixtureModel : model;
  const effective =
    adjustment === undefined ? base : (deepMerge(base, adjustment.overrides) as UpstreamModel);
  const displayName = typeof base.display_name === "string" ? base.display_name : base.slug;

  function openEditor() {
    setText(adjustment === undefined ? "{}" : JSON.stringify(adjustment.overrides, null, 2));
    setError("");
    setEditing(true);
  }

  function save() {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Overrides must be a JSON object.");
      }
      if (Object.hasOwn(parsed, "slug")) throw new Error("overrides.slug is not allowed");
      onSave({ slug: model.slug, overrides: parsed as Record<string, unknown> });
      setEditing(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <article className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted">
            <Tag>{model.slug}</Tag>
            {fieldTag(effective, "context_window")}
            {fieldTag(effective, "visibility")}
            {fieldTag(effective, "priority")}
            {fieldTag(effective, "default_reasoning_level")}
            {pinned ? <Tag>fixture</Tag> : null}
            {adjustment === undefined ? null : <Tag>adjusted</Tag>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fixtureModel === undefined ? null : (
            <button
              type="button"
              disabled={pending}
              onClick={onTogglePin}
              title={
                pinned
                  ? "Serve the fetched upstream version of this model"
                  : "Serve the baked-in fixture version of this model"
              }
              className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                pinned ? "bg-accent-dim text-accent" : "bg-canvas text-muted hover:text-ink"
              }`}
            >
              {pinned ? "Fixture version" : "Upstream version"}
            </button>
          )}
          {adjustment === undefined ? null : (
            <button
              type="button"
              disabled={pending}
              onClick={() => onRemove(model.slug)}
              className="rounded px-2 py-1 text-[10px] text-muted hover:bg-danger-dim hover:text-danger"
            >
              Remove adjustment
            </button>
          )}
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : openEditor())}
            className="rounded-full bg-canvas px-2.5 py-1 text-[10px] font-semibold text-muted hover:text-ink"
          >
            {editing ? "Close" : adjustment === undefined ? "Adjust" : "Edit adjustment"}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError("");
            }}
            spellCheck={false}
            className="input min-h-24 resize-y font-mono text-[10px] leading-4"
            placeholder='{"context_window": 1048576}'
          />
          {error === "" ? null : <p className="mt-1 text-[10px] text-red-400">{error}</p>}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-canvas disabled:opacity-50"
          >
            Save adjustment
          </button>
        </div>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-muted">
          Upstream original
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
          {JSON.stringify(model, null, 2)}
        </pre>
      </details>
      {fixtureModel === undefined ? null : (
        <details className="mt-2" open={pinned}>
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-muted">
            Fixture version
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
            {JSON.stringify(fixtureModel, null, 2)}
          </pre>
        </details>
      )}
      {adjustment === undefined ? null : (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-accent">
            Effective (after adjustment)
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
            {JSON.stringify(effective, null, 2)}
          </pre>
        </details>
      )}
    </article>
  );
}

function fieldTag(model: UpstreamModel, field: string) {
  const value = model[field];
  if (typeof value !== "string" && typeof value !== "number") return null;
  return (
    <Tag key={field}>
      {field}:{String(value)}
    </Tag>
  );
}

function modelDefinitions(body: unknown): UpstreamModel[] {
  if (typeof body !== "object" || body === null) return [];
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (model): model is UpstreamModel =>
      typeof model === "object" &&
      model !== null &&
      typeof (model as { slug?: unknown }).slug === "string",
  );
}

function deepMerge(base: unknown, overrides: unknown): unknown {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return overrides;
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    return overrides;
  }
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function RouteEditor({
  onCreate,
  templateSlugs,
}: {
  onCreate: (route: ModelRouteConfig) => void;
  templateSlugs: string[];
}) {
  const [api, setApi] = useState<"responses" | "anthropic-messages">("responses");
  const [maxTokens, setMaxTokens] = useState("32768");
  const [thinking, setThinking] = useState<"adaptive" | "budget" | "disabled">("adaptive");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("1");
  const [templateSlug, setTemplateSlug] = useState("");
  const [upstream, setUpstream] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [authorizationEnv, setAuthorizationEnv] = useState("");
  const [overrides, setOverrides] = useState("");
  const [overridesError, setOverridesError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    let parsedOverrides: Record<string, unknown> | undefined;
    if (overrides.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(overrides);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Overrides must be a JSON object.");
        }
        parsedOverrides = parsed as Record<string, unknown>;
        setOverridesError("");
      } catch (error) {
        setOverridesError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    onCreate({
      ...(api === "anthropic-messages"
        ? ({
            api,
            transport: "http",
            anthropic: { max_tokens: Number(maxTokens), thinking },
          } as const)
        : {}),
      authorization_env: authorizationEnv.trim(),
      enabled: true,
      model: {
        description: description.trim(),
        display_name: displayName.trim(),
        ...(parsedOverrides === undefined ? {} : { overrides: parsedOverrides }),
        priority: Number(priority),
        slug: slug.trim(),
        template_slug: templateSlug.trim(),
      },
      upstream: upstream.trim(),
      ...(upstreamModel.trim() === "" ? {} : { upstream_model: upstreamModel.trim() }),
    });
    setSlug("");
    setDisplayName("");
    setDescription("");
    setTemplateSlug("");
    setUpstream("");
    setUpstreamModel("");
    setOverrides("");
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <Field label="Upstream API">
        <select
          className="input"
          value={api}
          onChange={(event) => setApi(event.target.value as typeof api)}
        >
          <option value="responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages (including Bedrock Mantle)</option>
        </select>
      </Field>
      {api === "anthropic-messages" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Maximum output tokens">
            <input
              type="number"
              min="1"
              required
              className="input"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </Field>
          <Field label="Thinking">
            <select
              className="input"
              value={thinking}
              onChange={(event) => setThinking(event.target.value as typeof thinking)}
            >
              <option value="adaptive">Adaptive</option>
              <option value="budget">Token budget</option>
              <option value="disabled">Disabled</option>
            </select>
          </Field>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Slug">
          <input
            required
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className="input font-mono"
            placeholder="kimi-k3"
          />
        </Field>
        <Field label="Template slug">
          <input
            required
            value={templateSlug}
            onChange={(event) => setTemplateSlug(event.target.value)}
            className="input font-mono"
            placeholder="gpt-5.6-terra"
            list="route-template-slugs"
          />
        </Field>
      </div>
      <Field label="Display name">
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="input"
          placeholder="Kimi K3"
        />
      </Field>
      <Field label="Description">
        <textarea
          required
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="input min-h-16 resize-y"
          placeholder="Kimi K3 via CLIProxyAPI"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Priority">
          <input
            required
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="input"
          />
        </Field>
        <Field label="Authorization env">
          <input
            required
            value={authorizationEnv}
            onChange={(event) => setAuthorizationEnv(event.target.value)}
            className="input font-mono"
            placeholder="CLIPROXYAPI_KEY"
          />
        </Field>
      </div>
      <Field label="Upstream base URL">
        <input
          required
          value={upstream}
          onChange={(event) => setUpstream(event.target.value)}
          className="input font-mono"
          placeholder="http://127.0.0.1:8317/v1"
        />
      </Field>
      <Field label="Upstream model">
        <input
          value={upstreamModel}
          onChange={(event) => setUpstreamModel(event.target.value)}
          className="input font-mono"
          placeholder="Defaults to the slug"
        />
      </Field>
      <Field label="Overrides (JSON)">
        <div>
          <textarea
            value={overrides}
            onChange={(event) => {
              setOverrides(event.target.value);
              setOverridesError("");
            }}
            className="input min-h-20 resize-y font-mono"
            placeholder='{"context_window": 1048576}'
          />
          {overridesError === "" ? null : (
            <p className="mt-1 text-[10px] normal-case tracking-normal text-red-400">
              {overridesError}
            </p>
          )}
        </div>
      </Field>
      <button
        type="submit"
        className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-canvas transition hover:bg-accent-bright focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        Add route
      </button>
      <datalist id="route-template-slugs">
        {templateSlugs.map((slug) => (
          <option key={slug} value={slug} />
        ))}
      </datalist>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-canvas px-2 py-1 font-mono">{children}</span>;
}

function updateRoute(set: ModelRouteSet, index: number, replacement: ModelRouteConfig) {
  return {
    ...set,
    version: 1 as const,
    routes: set.routes.map((route, i) => (i === index ? replacement : route)),
  };
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import {
  getModelRouteEnvStatus,
  getModelRoutes,
  getModelsFixture,
  getRoutingTelemetry,
  getUpstreamCache,
  putModelRoutes,
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
  const telemetryQuery = useQuery({
    queryKey: ["routing-telemetry"],
    queryFn: getRoutingTelemetry,
    refetchInterval: 5000,
  });
  const telemetry = telemetryQuery.data ?? [];
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
  const set = query.data;

  if (query.isPending)
    return <EmptyState title="Loading model routes" detail="Reading the local route set…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  if (set === undefined) return null;

  const replace = (next: ModelRouteSet) => mutation.mutate(next);
  const add = (route: ModelRouteConfig) => replace({ ...set, routes: [...set.routes, route] });
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
    <div className="grid h-full min-h-0 grid-cols-1 overflow-y-auto lg:grid-cols-[1fr_24rem] lg:overflow-hidden">
      <section className="border-r border-line p-6 lg:min-h-0 lg:overflow-y-auto lg:p-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="section-label">Alternate upstreams</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Model routes</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
              Advertise extra models and reroute their Responses traffic — HTTP and WebSocket — to
              another upstream with its own credentials. Tokens stay in the proxy environment.
            </p>
          </div>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
            {set.routes.length} routes
          </span>
        </div>
        {mutation.isError ? (
          <p className="mb-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="space-y-2">
          {set.routes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
              No model routes yet.
            </div>
          ) : (
            set.routes.map((route, index) => (
              <RouteCard
                key={`${route.model.slug}-${index}`}
                route={route}
                envSet={envQuery.data?.[route.authorization_env]}
                telemetry={telemetry.find(
                  (entry) => entry.action === "routed" && entry.routeSlug === route.model.slug,
                )}
                onToggle={() =>
                  replace(updateRoute(set, index, { ...route, enabled: !(route.enabled ?? true) }))
                }
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
        <p className="mt-2 text-xs leading-5 text-muted">
          The advertised model clones an upstream template. Requests naming the slug are rewritten
          to the upstream model and sent with the named env var as bearer token.
        </p>
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

function RouteCard({
  route,
  envSet,
  telemetry,
  onToggle,
  onDelete,
}: {
  route: ModelRouteConfig;
  envSet?: boolean;
  telemetry?: RoutingTelemetry;
  onToggle: () => void;
  onDelete: () => void;
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
                onClick={onToggle}
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"}`}
              >
                {enabled ? "Enabled" : "Disabled"}
              </button>
              <button
                type="button"
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
            {route.upstream_model === undefined ? null : <Tag>as:{route.upstream_model}</Tag>}
            <Tag>
              ${route.authorization_env}
              {envSet === undefined ? "" : envSet ? " set" : " missing"}
            </Tag>
            {telemetry === undefined ? null : (
              <Tag>
                routed:{telemetry.count} · last {new Date(telemetry.lastSeenAt).toLocaleString()}
              </Tag>
            )}
          </div>
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
        </div>
      </div>
    </article>
  );
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

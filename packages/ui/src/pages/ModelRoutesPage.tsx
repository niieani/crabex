import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import {
  getModelRouteEnvStatus,
  getModelRoutes,
  getRoutingTelemetry,
  putModelRoutes,
} from "../lib/api.ts";
import type { ModelRouteConfig, ModelRouteSet, RoutingTelemetry } from "../lib/types.ts";

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
  const add = (route: ModelRouteConfig) => replace({ version: 1, routes: [...set.routes, route] });

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
                  replace({ version: 1, routes: set.routes.filter((_, i) => i !== index) })
                }
              />
            ))
          )}
        </div>
      </section>
      <aside className="bg-panel p-5 lg:min-h-0 lg:overflow-y-auto">
        <p className="section-label">New route</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          The advertised model clones an upstream template. Requests naming the slug are rewritten
          to the upstream model and sent with the named env var as bearer token.
        </p>
        <RouteEditor onCreate={add} />
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

function RouteEditor({ onCreate }: { onCreate: (route: ModelRouteConfig) => void }) {
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
    version: 1 as const,
    routes: set.routes.map((route, i) => (i === index ? replacement : route)),
  };
}

import type { ModelRouteConfig, ToolAction, ToolPolicyKey } from "../../lib/types.ts";

const TOOL_KEYS: ToolPolicyKey[] = [
  "function",
  "namespace",
  "custom",
  "web_search",
  "tool_search",
  "other",
];

const TOOL_LABELS: Record<ToolPolicyKey, string> = {
  function: "Function",
  namespace: "Namespace",
  custom: "Custom",
  web_search: "Web search",
  tool_search: "Tool search",
  other: "Other / unknown",
};

export function brokerRouteIssue(
  slug: string,
  routes: ModelRouteConfig[],
  envStatus?: Record<string, boolean>,
): string | undefined {
  const broker = routes.find((route) => route.model.slug === slug);
  if (!broker) return `Search broker route "${slug}" is missing.`;
  if (broker.api === "anthropic-messages")
    return `Search broker route "${slug}" must use OpenAI Responses.`;
  if (broker.enabled === false) return `Search broker route "${slug}" is disabled.`;
  if (broker.effective_tool_policy?.web_search !== "pass")
    return `Search broker route "${slug}" needs web_search: pass.`;
  if (envStatus?.[broker.authorization_env] === false)
    return `Search broker route "${slug}" has no authorization in the proxy process.`;
  return undefined;
}

export function BrokerRouteOptions({
  routes,
  selected,
}: {
  routes: ModelRouteConfig[];
  selected: string;
}) {
  const choices = routes.filter((route) => route.api !== "anthropic-messages");
  return (
    <>
      {selected && !choices.some((route) => route.model.slug === selected) ? (
        <option value={selected}>{selected} (unavailable)</option>
      ) : null}
      {choices.map((route) => (
        <option key={route.model.slug} value={route.model.slug}>
          {route.model.slug}
        </option>
      ))}
    </>
  );
}

export function RouteCapabilities({
  route,
  routes,
  defaultBroker,
  envStatus,
  pending,
  onUpdate,
}: {
  route: ModelRouteConfig;
  routes: ModelRouteConfig[];
  defaultBroker: string;
  envStatus?: Record<string, boolean>;
  pending: boolean;
  onUpdate: (route: ModelRouteConfig) => void;
}) {
  const legacy = route.allowed_tool_types !== undefined;
  const effective = route.effective_tool_policy;
  const actions = route.tool_policy_actions;
  const broker = route.search_broker?.route ?? defaultBroker;
  const brokerIssue =
    route.api === "anthropic-messages" && effective?.web_search === "broker"
      ? brokerRouteIssue(broker, routes, envStatus)
      : undefined;
  const delegation = route.model.overrides?.multi_agent_version;

  function setToolAction(type: ToolPolicyKey, value: string) {
    const policy = { ...route.tool_policy };
    if (value === "inherit") delete policy[type];
    else policy[type] = value as ToolAction;
    onUpdate({
      ...route,
      tool_policy: Object.keys(policy).length ? policy : undefined,
    });
  }

  function migrateAllowlist() {
    if (!effective) return;
    const converted = { ...route, tool_policy: { ...effective } };
    delete converted.allowed_tool_types;
    onUpdate(converted);
  }

  function setDelegation(value: string) {
    const overrides = { ...route.model.overrides };
    if (value === "inherit") delete overrides.multi_agent_version;
    else overrides.multi_agent_version = value;
    onUpdate({
      ...route,
      model: {
        ...route.model,
        overrides: Object.keys(overrides).length ? overrides : undefined,
      },
    });
  }

  return (
    <details className="mt-4 border-t border-line/60 pt-3">
      <summary className="cursor-pointer text-xs font-semibold text-content">
        Tools, search, and agents
      </summary>
      <div className="mt-4 space-y-5">
        <section>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold">Tool policy</h3>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                Inherited actions use provider defaults. Omit removes a declaration and records it;
                reject returns a visible error.
              </p>
            </div>
            {legacy ? (
              <button
                type="button"
                disabled={pending || !effective}
                onClick={migrateAllowlist}
                className="rounded-lg border border-accent/40 px-2.5 py-1.5 text-[11px] text-accent disabled:opacity-50"
              >
                Convert allowlist to policy
              </button>
            ) : null}
          </div>
          {legacy ? (
            <p className="mt-2 text-[11px] text-warning">
              Legacy allowed_tool_types is active. Convert it to edit actions without changing the
              effective policy.
            </p>
          ) : null}
          {!effective || !actions ? (
            <p className="mt-2 text-[11px] text-muted">Policy metadata is unavailable.</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {TOOL_KEYS.map((type) => (
                <label key={type} className="rounded-lg border border-line/60 bg-canvas/50 p-2.5">
                  <span className="block text-[11px] font-semibold">{TOOL_LABELS[type]}</span>
                  <select
                    aria-label={`${route.model.slug} ${TOOL_LABELS[type]} action`}
                    className="input mt-1.5 text-xs"
                    value={legacy ? effective[type] : (route.tool_policy?.[type] ?? "inherit")}
                    disabled={pending || legacy}
                    onChange={(event) => setToolAction(type, event.target.value)}
                  >
                    {!legacy ? <option value="inherit">Inherit provider default</option> : null}
                    {actions[type].map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[10px] text-muted">
                    Effective: {effective[type]} ·{" "}
                    {legacy ? "legacy" : route.tool_policy?.[type] ? "override" : "default"}
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        {route.api === "anthropic-messages" ? (
          <section className="border-t border-line/60 pt-4">
            <label className="text-xs font-semibold" htmlFor={`broker-${route.model.slug}`}>
              Search broker override
            </label>
            <select
              id={`broker-${route.model.slug}`}
              className="input mt-2 text-xs"
              value={route.search_broker?.route ?? "inherit"}
              disabled={pending}
              onChange={(event) => {
                const value = event.target.value;
                onUpdate({
                  ...route,
                  search_broker: value === "inherit" ? undefined : { route: value },
                });
              }}
            >
              <option value="inherit">Use proxy default ({defaultBroker})</option>
              <BrokerRouteOptions routes={routes} selected={route.search_broker?.route ?? ""} />
            </select>
            <p className="mt-1 text-[11px] text-muted">Effective broker: {broker}</p>
            {brokerIssue ? (
              <p
                role="alert"
                className="mt-2 rounded-md bg-danger-dim px-2.5 py-2 text-[11px] text-danger"
              >
                {brokerIssue}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="border-t border-line/60 pt-4">
          <label className="text-xs font-semibold" htmlFor={`delegation-${route.model.slug}`}>
            Allow this model&apos;s children to delegate
          </label>
          <select
            id={`delegation-${route.model.slug}`}
            className="input mt-2 text-xs"
            value={delegation === "v2" || delegation === "disabled" ? delegation : "inherit"}
            disabled={pending}
            onChange={(event) => setDelegation(event.target.value)}
          >
            <option value="inherit">Inherit catalog / Codex default</option>
            <option value="v2">Allow delegation (V2)</option>
            <option value="disabled">Leaf only (disabled)</option>
          </select>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Sets the model catalog&apos;s multi_agent_version. Codex&apos;s global multi_agent_v2
            feature flag (or disabled agents) takes precedence over the catalog; the catalog takes
            precedence over the default feature state. A thread keeps its chosen version. This does
            not enable native-to-routed plaintext handoff.
          </p>
        </section>
      </div>
    </details>
  );
}

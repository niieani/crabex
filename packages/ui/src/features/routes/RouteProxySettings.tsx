import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getProxyConfig, patchProxyConfig } from "../../lib/api.ts";
import type { ModelRouteConfig } from "../../lib/types.ts";
import { brokerRouteIssue, BrokerRouteOptions } from "./RouteCapabilities.tsx";

export function RouteProxySettings({
  routes,
  envStatus,
}: {
  routes: ModelRouteConfig[];
  envStatus?: Record<string, boolean>;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["proxy-config"], queryFn: getProxyConfig });
  const mutation = useMutation({
    mutationFn: patchProxyConfig,
    onSuccess: (state) => client.setQueryData(["proxy-config"], state),
  });
  const state = query.data;
  if (query.isError)
    return <p className="mb-4 text-xs text-danger">Proxy settings: {query.error.message}</p>;
  if (!state) return null;
  const brokerIssue = brokerRouteIssue(state.search_broker.route, routes, envStatus);
  return (
    <section className="mb-6 rounded-xl border border-line bg-panel p-4">
      <h3 className="text-sm font-semibold">Route-wide settings</h3>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div>
          <label htmlFor="default-search-broker" className="text-xs font-semibold">
            Default web search broker
          </label>
          <select
            id="default-search-broker"
            className="input mt-2 text-xs"
            value={state.search_broker.route}
            disabled={mutation.isPending}
            onChange={(event) => mutation.mutate({ search_broker: { route: event.target.value } })}
          >
            <BrokerRouteOptions routes={routes} selected={state.search_broker.route} />
          </select>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Anthropic routes with web_search: broker use this OpenAI Responses route unless they set
            an override. Default: gpt-6-luna. The broker route must be enabled, authorized, and pass
            web search.
          </p>
          {brokerIssue ? (
            <p
              role="alert"
              className="mt-2 rounded-md bg-danger-dim px-2.5 py-2 text-[11px] text-danger"
            >
              {brokerIssue}
            </p>
          ) : null}
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold">Native parents to routed agents</h4>
            <button
              type="button"
              role="switch"
              aria-label="Native parents to routed agents"
              aria-checked={state.routed_agents.enabled}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({ routed_agents: { enabled: !state.routed_agents.enabled } })
              }
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                state.routed_agents.enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"
              }`}
            >
              {state.routed_agents.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Adds plaintext routed_agents tools for native parents to reach custom-model children.
            This opt-in relies on undocumented Codex backend behavior. Native-to-native agent tools
            stay encrypted.
          </p>
        </div>
      </div>
      {mutation.isError ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {mutation.error.message}
        </p>
      ) : null}
    </section>
  );
}

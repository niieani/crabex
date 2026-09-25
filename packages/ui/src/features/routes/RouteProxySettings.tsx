import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getProxyConfig, patchProxyConfig } from "../../lib/api.ts";
import type { ModelRouteConfig } from "../../lib/types.ts";
import { brokerRouteIssue, BrokerRouteOptions } from "./RouteCapabilities.tsx";

export function RouteProxySettings({ routes }: { routes: ModelRouteConfig[] }) {
  const [instructions, setInstructions] = useState("");
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["proxy-config"], queryFn: getProxyConfig });
  const mutation = useMutation({
    mutationFn: patchProxyConfig,
    onSuccess: (state) => {
      client.setQueryData(["proxy-config"], state);
      void client.invalidateQueries({ queryKey: ["model-routes"] });
    },
  });
  const state = query.data;
  useEffect(() => {
    setInstructions(state?.routed_agents.instructions ?? "");
  }, [state?.routed_agents.instructions]);
  if (query.isError)
    return <p className="mb-4 text-xs text-danger">Proxy settings: {query.error.message}</p>;
  if (!state) return null;
  const brokerIssue = brokerRouteIssue(state.search_broker.route, routes);
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
                mutation.mutate({
                  routed_agents: {
                    ...state.routed_agents,
                    enabled: !state.routed_agents.enabled,
                  },
                })
              }
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                state.routed_agents.enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"
              }`}
            >
              {state.routed_agents.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Adds routed_agents tools for native parents to reach routes in the plaintext handoff
            class. This opt-in relies on undocumented Codex backend behavior. Native-to-native agent
            tools stay encrypted.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold">Prefer native models in spawn list</h4>
            <button
              type="button"
              role="switch"
              aria-label="Prefer native models in spawn list"
              aria-checked={state.routed_agents.prefer_native_spawn_models ?? false}
              disabled={mutation.isPending || !state.routed_agents.enabled}
              onClick={() =>
                mutation.mutate({
                  routed_agents: {
                    ...state.routed_agents,
                    prefer_native_spawn_models: !state.routed_agents.prefer_native_spawn_models,
                  },
                })
              }
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                state.routed_agents.prefer_native_spawn_models
                  ? "bg-accent-dim text-accent"
                  : "bg-canvas text-muted"
              }`}
            >
              {state.routed_agents.prefer_native_spawn_models ? "Enabled" : "Disabled"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Moves plaintext-class routes after native-capable models in the served catalog. This
            also changes /model picker order. If fewer than five native models are visible, a
            plaintext route may still appear in the native spawn list.
          </p>
          <label htmlFor="routed-agent-instructions" className="mt-3 block text-xs font-semibold">
            Routed agent instructions
          </label>
          <textarea
            id="routed-agent-instructions"
            className="input mt-2 min-h-20 text-xs"
            maxLength={1200}
            value={instructions}
            disabled={mutation.isPending}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="When should native agents use these routes?"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[10px] text-muted">{instructions.length}/1200 characters</span>
            <button
              type="button"
              className="rounded-lg border border-accent/40 px-2.5 py-1.5 text-[11px] text-accent disabled:opacity-50"
              disabled={
                mutation.isPending || instructions === (state.routed_agents.instructions ?? "")
              }
              onClick={() =>
                mutation.mutate({
                  routed_agents: { ...state.routed_agents, instructions },
                })
              }
            >
              Save instructions
            </button>
          </div>
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

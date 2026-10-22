import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import {
  deleteConfigBundle,
  getConfigBundle,
  getRoutingTelemetry,
  getUpstreamCache,
  putConfigBundle,
} from "../lib/api.ts";

export function ConfigBundlePage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["config-bundle"], queryFn: getConfigBundle });
  const telemetryQuery = useQuery({
    queryKey: ["routing-telemetry"],
    queryFn: getRoutingTelemetry,
    refetchInterval: 5000,
  });
  const served = (telemetryQuery.data?.telemetry ?? []).find(
    (entry) => entry.action === "bundle-override",
  );
  const upstreamQuery = useQuery({
    queryKey: ["upstream-cache"],
    queryFn: getUpstreamCache,
    refetchInterval: 5000,
  });
  const upstreamBundle = upstreamQuery.data?.configBundle;
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState("");

  useEffect(() => {
    if (query.data === undefined) return;
    setEnabled(query.data.enabled);
    setText(
      query.data.bundle === null || query.data.bundle === undefined
        ? ""
        : JSON.stringify(query.data.bundle, null, 2),
    );
  }, [query.data]);

  const save = useMutation({
    mutationFn: putConfigBundle,
    onSuccess: (override) => queryClient.setQueryData(["config-bundle"], override),
  });
  const reset = useMutation({
    mutationFn: deleteConfigBundle,
    onSuccess: (override) => queryClient.setQueryData(["config-bundle"], override),
  });

  if (query.isPending)
    return <EmptyState title="Loading config bundle" detail="Reading the local override…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;

  function submit() {
    let bundle: unknown = query.data?.bundle ?? null;
    if (enabled) {
      try {
        bundle = text.trim() === "" ? null : JSON.parse(text);
        if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
          throw new Error("Bundle must be a JSON object.");
        }
        setParseError("");
      } catch (error) {
        setParseError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    save.mutate({ version: 1, enabled, bundle });
  }

  return (
    <div className="h-full overflow-y-auto">
      <section className="mx-auto max-w-3xl p-6 lg:p-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="section-label">Managed policy</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Advanced</h1>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Enable configuration override"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`toggle-switch ${enabled ? "on" : ""}`}
          >
            <span />
          </button>
        </div>
        {save.isError ? (
          <p className="mb-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            {save.error.message}
          </p>
        ) : null}
        <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
          <span className="mb-1.5 block">Bundle JSON</span>
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setParseError("");
            }}
            disabled={!enabled}
            spellCheck={false}
            className="input min-h-72 resize-y font-mono text-xs leading-5 disabled:opacity-50"
            placeholder={'{\n  "config_toml": null,\n  "requirements_toml": null\n}'}
          />
        </label>
        {parseError === "" ? null : (
          <p className="mt-1 text-[10px] normal-case tracking-normal text-red-400">{parseError}</p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-canvas transition hover:bg-accent-bright focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
          >
            Save override
          </button>
          <button
            type="button"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            className="rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-danger-dim hover:text-danger disabled:opacity-50"
          >
            Reset to passthrough
          </button>
        </div>
        {served === undefined ? null : (
          <p className="mt-4 text-[10px] text-muted">
            Served locally {served.count}× · last {new Date(served.lastSeenAt).toLocaleString()}
          </p>
        )}
        <div className="mt-8">
          <p className="section-label">Observed upstream</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">Last upstream bundle</h2>
          {upstreamBundle === undefined ? (
            <p className="mt-2 text-sm leading-6 text-muted">
              No upstream bundle observed yet. It is recorded whenever the bundle request passes
              through — and, while the override is enabled, refreshed in the background (at most
              once a minute) using the incoming request's own credentials.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[10px] text-muted">
                fetched {new Date(upstreamBundle.fetchedAt).toLocaleString()}
              </p>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] leading-5 text-content">
                {JSON.stringify(upstreamBundle.body, null, 2)}
              </pre>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

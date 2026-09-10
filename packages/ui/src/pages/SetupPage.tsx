import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { getCodexConfig, putCodexConfig } from "../lib/api.ts";
import type { CodexConfigToggle } from "../lib/types.ts";

export function SetupPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["codex-config"], queryFn: getCodexConfig });
  const mutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      putCodexConfig(key, enabled),
    onSuccess: (state) => queryClient.setQueryData(["codex-config"], state),
  });
  const state = query.data;

  if (query.isPending)
    return <EmptyState title="Loading Codex setup" detail="Reading the Codex config…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  if (state === undefined) return null;

  return (
    <div className="h-full overflow-y-auto">
      <section className="mx-auto max-w-3xl p-6 lg:p-8">
        <div className="mb-6">
          <p className="section-label">Host integration</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Codex setup</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
            Point Codex at this proxy by editing <code className="font-mono">{state.path}</code>.
            Edits are fenced in comment blocks; your own values are commented out while a toggle is
            on and restored when it is turned off.
          </p>
          <p className="mt-2 font-mono text-[10px] text-muted">{state.path}</p>
        </div>
        {state.parseError === undefined ? null : (
          <p className="mb-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            Could not parse config.toml: {state.parseError}
          </p>
        )}
        {mutation.isError ? (
          <p className="mb-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="space-y-2">
          {state.toggles.map((toggle) => (
            <ToggleCard
              key={toggle.key}
              toggle={toggle}
              pending={mutation.isPending}
              onChange={(enabled) => mutation.mutate({ key: toggle.key, enabled })}
            />
          ))}
        </div>
        {state.exists ? null : (
          <p className="mt-4 text-xs text-muted">
            The config file does not exist yet; it will be created when you enable a toggle.
          </p>
        )}
      </section>
    </div>
  );
}

function ToggleCard({
  toggle,
  pending,
  onChange,
}: {
  toggle: CodexConfigToggle;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <article
      className={`rounded-xl border p-4 ${toggle.enabled ? "border-line bg-panel" : "border-line/60 bg-panel/40"}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{toggle.label}</h2>
          <p className="mt-1 font-mono text-[10px] text-muted">{toggle.key}</p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => onChange(!toggle.enabled)}
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
            toggle.enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"
          }`}
        >
          {toggle.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">{toggle.description}</p>
      <div className="mt-3 space-y-1.5 text-[10px]">
        <p className="font-mono text-muted">
          proxied: <span className="text-content">{toggle.managedValue}</span>
        </p>
        {toggle.enabled && toggle.preservedValue !== undefined ? (
          <p className="font-mono text-muted">
            preserved: <span className="text-content">{toggle.preservedValue}</span> — restored when
            disabled
          </p>
        ) : null}
        {!toggle.enabled &&
        toggle.effectiveValue !== undefined &&
        toggle.effectiveValue !== toggle.managedValue ? (
          <p className="font-mono text-muted">
            current: <span className="text-content">{toggle.effectiveValue}</span> (your setting,
            kept)
          </p>
        ) : null}
      </div>
    </article>
  );
}

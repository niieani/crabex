import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { TomlEditor } from "../features/config-bundle/TomlEditor.tsx";
import {
  fragments,
  record,
  sections,
  validation,
  type Fragment,
  type Section,
} from "../features/config-bundle/bundle.ts";
import {
  deleteConfigBundle,
  getConfigBundle,
  getEffectiveConfigBundle,
  getRoutingTelemetry,
  getUpstreamCache,
  putConfigBundle,
} from "../lib/api.ts";

const button = "rounded-lg border border-line px-3 py-2 text-xs text-muted disabled:opacity-50";
export function ConfigBundlePage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["config-bundle"], queryFn: getConfigBundle });
  const upstream = useQuery({
    queryKey: ["upstream-cache"],
    queryFn: getUpstreamCache,
    refetchInterval: 5000,
  });
  const effective = useQuery({
    queryKey: ["config-bundle-effective"],
    queryFn: getEffectiveConfigBundle,
    refetchInterval: 5000,
  });
  const telemetry = useQuery({
    queryKey: ["routing-telemetry"],
    queryFn: getRoutingTelemetry,
    refetchInterval: 5000,
  });
  const [browserAccess, setBrowserAccess] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [bundle, setBundle] = useState<unknown>(null);
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState("");
  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.enabled);
    setBrowserAccess(query.data.workarounds?.cua_repl_browser_access ?? false);
    // An absent bundle is a new override; legacy overrides retain replace semantics.
    setMode(query.data.mode ?? (query.data.bundle == null ? "merge" : "replace"));
    setBundle(query.data.bundle);
    setText(JSON.stringify(query.data.bundle, null, 2));
    setParseError("");
  }, [query.data]);
  const updated = (override: Awaited<ReturnType<typeof putConfigBundle>>) => {
    client.setQueryData(["config-bundle"], override);
    void client.invalidateQueries({ queryKey: ["config-bundle-effective"] });
  };
  const save = useMutation({ mutationFn: putConfigBundle, onSuccess: updated });
  const reset = useMutation({ mutationFn: deleteConfigBundle, onSuccess: updated });
  if (query.isPending)
    return <EmptyState title="Loading config bundle" detail="Reading the local override…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  function replaceFragments(section: Section, next: Fragment[]) {
    setBundle({
      ...record(bundle),
      [section]: { ...record(record(bundle)[section]), enterprise_managed: next },
    });
  }
  function switchTab(nextRaw: boolean) {
    if (nextRaw) {
      setText(JSON.stringify(bundle, null, 2));
      setRaw(true);
    } else {
      try {
        const next: unknown = JSON.parse(text);
        const error = validation(next);
        if (error) throw new Error(error);
        setBundle(next);
        setRaw(false);
        setParseError("");
      } catch (error) {
        setParseError(error instanceof Error ? error.message : String(error));
      }
    }
  }
  let draft = bundle;
  let error = parseError;
  if (raw) {
    try {
      draft = JSON.parse(text);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  error ||= validation(draft) ?? "";
  if (enabled && draft === null) error ||= "Enabled override requires a JSON object bundle.";
  const served =
    telemetry.data?.telemetry.filter(
      (entry) => entry.action === "bundle-override" || entry.action === "bundle-merge",
    ) ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <section className="mx-auto max-w-3xl p-6 lg:p-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="section-label">Managed policy</p>
            <h1 className="mt-2 text-2xl font-semibold">Advanced</h1>
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
        <div className="mb-6 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="section-label">Temporary workaround</p>
              <p className="mt-1 text-sm">Browser use outside the ChatGPT app</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Browser use outside the ChatGPT app"
              aria-checked={browserAccess}
              className={`toggle-switch ${browserAccess ? "on" : ""}`}
              onClick={() => setBrowserAccess(!browserAccess)}
            >
              <span />
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Since unified-computer-use 26.1023.50603, the plugin’s cua_repl preloads
            require-browser-access.mjs, which only the ChatGPT app can satisfy, so Codex CLI /
            app-server hosts like T3 Code fail with “The browser access host is unavailable”.
          </p>
          <p className="mt-2 text-xs text-muted">
            Temporary workaround for{" "}
            <a
              className="text-accent underline"
              href="https://github.com/openai/codex/issues/57641"
              target="_blank"
              rel="noreferrer"
            >
              openai/codex#57641
            </a>
            ; turn it off once upstream fixes it. Save to apply. Works independently of the general
            override.
          </p>
          <p className="mt-2 text-xs text-muted">
            Saved workaround: {effective.data?.workaround?.status ?? "disabled"}
            {effective.data?.workaround?.version
              ? ` for version ${effective.data.workaround.version}`
              : ""}
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Bundle mode">
          {(["replace", "merge"] as const).map((value) => (
            <button
              key={value}
              className={button}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "merge" ? "Merge into upstream" : "Replace upstream"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode === "merge"
            ? "Your fragments take precedence over the organisation's; same id replaces theirs."
            : "Codex sees only your bundle."}
        </p>
        <p className="mt-2 text-xs text-muted">
          Codex only fetches the bundle for business/enterprise/edu ChatGPT plans. Running Codex
          processes refresh it about every 15 minutes; restart Codex to apply changes immediately.
        </p>
        <div className="my-4 flex gap-2">
          <button className={button} aria-pressed={!raw} onClick={() => switchTab(false)}>
            Fragments
          </button>
          <button className={button} aria-pressed={raw} onClick={() => switchTab(true)}>
            Raw JSON
          </button>
        </div>
        {raw ? (
          <label className="block">
            Bundle JSON
            <textarea
              aria-label="Bundle JSON"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setParseError("");
              }}
              className="input min-h-72 font-mono text-xs"
              spellCheck={false}
            />
          </label>
        ) : (
          sections.map((section) => (
            <div key={section} className="mt-6">
              <h2 className="section-label">
                {section === "config_toml" ? "config.toml" : "requirements.toml"} fragments
              </h2>
              {fragments(bundle, section).map((fragment, index, list) => {
                const edit = (patch: Partial<Fragment>) =>
                  replaceFragments(
                    section,
                    list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
                  );
                const move = (offset: number) => {
                  const next = [...list];
                  [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
                  replaceFragments(section, next);
                };
                return (
                  <div key={index} className="mt-3 space-y-2 rounded-lg border border-line p-3">
                    <p className="text-xs text-muted">
                      {index === 0 ? "Highest precedence" : `Precedence ${index + 1}`}
                    </p>
                    <label className="block text-xs">
                      ID
                      <input
                        aria-label={`${section} fragment ${index + 1} id`}
                        className="input"
                        value={fragment.id}
                        onChange={(e) => edit({ id: e.target.value })}
                      />
                    </label>
                    <label className="block text-xs">
                      Name
                      <input
                        aria-label={`${section} fragment ${index + 1} name`}
                        className="input"
                        value={fragment.name}
                        onChange={(e) => edit({ name: e.target.value })}
                      />
                    </label>
                    <TomlEditor
                      label={`${section} fragment ${index + 1} TOML`}
                      value={fragment.contents}
                      onChange={(contents) => edit({ contents })}
                    />
                    <div className="flex gap-2">
                      <button className={button} disabled={index === 0} onClick={() => move(-1)}>
                        Move up
                      </button>
                      <button
                        className={button}
                        disabled={index === list.length - 1}
                        onClick={() => move(1)}
                      >
                        Move down
                      </button>
                      <button
                        className={button}
                        onClick={() =>
                          replaceFragments(
                            section,
                            list.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Delete fragment
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                className={button + " mt-3"}
                onClick={() =>
                  replaceFragments(section, [
                    ...fragments(bundle, section),
                    { id: crypto.randomUUID(), name: "", contents: "" },
                  ])
                }
              >
                Add {section === "config_toml" ? "config.toml" : "requirements.toml"} fragment
              </button>
            </div>
          ))
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
        {save.isError && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {save.error.message}
          </p>
        )}
        {reset.isError && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {reset.error.message}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            className={button}
            disabled={save.isPending || !!error}
            onClick={() =>
              save.mutate({
                version: 1,
                enabled,
                mode,
                bundle: draft,
                workarounds: { ...query.data.workarounds, cua_repl_browser_access: browserAccess },
              })
            }
          >
            Save override
          </button>
          <button className={button} disabled={reset.isPending} onClick={() => reset.mutate()}>
            Reset to passthrough
          </button>
        </div>
        {served.map((entry) => (
          <p key={entry.action} className="mt-3 text-xs text-muted">
            Served locally {entry.count}× · last {new Date(entry.lastSeenAt).toLocaleString()}
          </p>
        ))}
        <div className="mt-8">
          <h2 className="section-label">Observed upstream</h2>
          {upstream.isError ? (
            <p role="alert">{upstream.error.message}</p>
          ) : upstream.data?.configBundle ? (
            <>
              <p className="mt-2 text-xs text-muted">
                fetched {new Date(upstream.data.configBundle.fetchedAt).toLocaleString()}
              </p>
              <BundlePreview bundle={upstream.data.configBundle.body} />
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No upstream bundle observed yet. Merge refreshes it on each request; replace refreshes
              it in the background at most once a minute.
            </p>
          )}
        </div>
        <details className="mt-8">
          <summary className="section-label cursor-pointer">Effective bundle</summary>
          {effective.isError ? (
            <p role="alert">{effective.error.message}</p>
          ) : (
            effective.data && (
              <BundlePreview
                bundle={effective.data.bundle}
                local={query.data.enabled ? query.data.bundle : {}}
                workaroundId={effective.data.workaround?.fragment?.id}
              />
            )
          )}
        </details>
      </section>
    </div>
  );
}

function BundlePreview({
  bundle,
  local,
  workaroundId,
}: {
  bundle: unknown;
  local?: unknown;
  workaroundId?: string;
}) {
  return (
    <div>
      {sections.map((section) => {
        const managed = record(record(record(bundle)[section]).managed_layers);
        const groups = [
          { label: "enterprise_managed", items: fragments(bundle, section) },
          ...["baseline", "system_overlay"].map((label) => ({
            label: "managed_layers." + label,
            items: Array.isArray(managed[label]) ? (managed[label] as Fragment[]) : [],
          })),
        ];
        return (
          <div key={section} className="mt-3">
            <h3 className="text-xs text-muted">
              {section === "config_toml" ? "config.toml" : "requirements.toml"} fragments
            </h3>
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <div key={group.label}>
                  <p className="mt-2 text-xs text-muted">{group.label}</p>
                  {group.items.map((fragment, index) => (
                    <div key={index} className="mt-2 space-y-2">
                      <p className="text-xs">
                        {fragment.id} · {fragment.name}{" "}
                        {local !== undefined && (
                          <span className="rounded border border-line px-1 text-muted">
                            {group.label === "enterprise_managed" && fragment.id === workaroundId
                              ? "workaround"
                              : group.label === "enterprise_managed" &&
                                  fragments(local, section).some((item) => item.id === fragment.id)
                                ? "local"
                                : "upstream"}
                          </span>
                        )}
                      </p>
                      <TomlEditor
                        readOnly
                        label={`${section} ${group.label} observed ${index + 1} TOML`}
                        value={typeof fragment.contents === "string" ? fragment.contents : ""}
                      />
                    </div>
                  ))}
                </div>
              ))}
          </div>
        );
      })}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">Raw bundle JSON</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(bundle, null, 2)}
        </pre>
      </details>
    </div>
  );
}

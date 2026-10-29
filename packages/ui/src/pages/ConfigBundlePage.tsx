import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
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
  getProxyConfig,
  getRoutingTelemetry,
  getUpstreamCache,
  putConfigBundle,
} from "../lib/api.ts";

const button = "rounded-lg border border-line px-3 py-2 text-xs text-muted disabled:opacity-50";
const pressable =
  button + " aria-pressed:border-accent aria-pressed:bg-accent-dim aria-pressed:text-accent";
const sectionLabel = (section: Section) =>
  section === "config_toml" ? "config.toml" : "requirements.toml";

type PageTab = "workarounds" | "organisation" | "effective" | "local";
type EditorTab = Section | "raw";

export function ConfigBundlePage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["config-bundle"], queryFn: getConfigBundle });
  const proxyConfig = useQuery({ queryKey: ["proxy-config"], queryFn: getProxyConfig });
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
  const [tab, setTab] = useState<PageTab>("workarounds");
  const [browserAccess, setBrowserAccess] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [bundle, setBundle] = useState<unknown>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("config_toml");
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
  const stored = query.data;
  const localPolicyAllowed = proxyConfig.data?.local_policy_override === true;
  const workaround = effective.data?.workaround;

  function saveWorkaround(next: boolean) {
    setBrowserAccess(next);
    save.mutate({
      ...stored,
      workarounds: { ...stored.workarounds, cua_repl_browser_access: next },
    });
  }
  function replaceFragments(section: Section, next: Fragment[]) {
    setBundle({
      ...record(bundle),
      [section]: { ...record(record(bundle)[section]), enterprise_managed: next },
    });
  }
  function switchEditorTab(next: EditorTab) {
    if (next === "raw") {
      if (editorTab !== "raw") setText(JSON.stringify(bundle, null, 2));
      setEditorTab("raw");
      return;
    }
    if (editorTab === "raw") {
      try {
        const parsed: unknown = JSON.parse(text);
        const error = validation(parsed);
        if (error) throw new Error(error);
        setBundle(parsed);
        setParseError("");
      } catch (error) {
        setParseError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setEditorTab(next);
  }

  let draft = bundle;
  let error = parseError;
  if (editorTab === "raw") {
    try {
      draft = JSON.parse(text);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  error ||= validation(draft) ?? "";
  if (enabled && draft === null) error ||= "Serving a local policy requires a JSON object bundle.";
  const served =
    telemetry.data?.telemetry.filter(
      (entry) => entry.action === "bundle-override" || entry.action === "bundle-merge",
    ) ?? [];
  const observed = upstream.data?.configBundle;
  const tabs: Array<{ id: PageTab; label: string }> = [
    { id: "workarounds", label: "Workarounds" },
    { id: "organisation", label: "Organisation bundle" },
    { id: "effective", label: "What Codex receives" },
    ...(localPolicyAllowed ? [{ id: "local" as const, label: "Local policy" }] : []),
  ];
  const activeTab = tab === "local" && !localPolicyAllowed ? "workarounds" : tab;

  return (
    <div className="h-full overflow-y-auto">
      <section className="mx-auto max-w-3xl p-6 lg:p-8">
        <p className="section-label">Advanced</p>
        <h1 className="mt-2 text-2xl font-semibold">Managed config bundle</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          On business, enterprise and edu ChatGPT plans, Codex loads a managed config bundle from
          ChatGPT. It sits between <code>/etc/codex</code> and your{" "}
          <code>~/.codex/config.toml</code>. Running Codex processes refresh it about every 15
          minutes; restart Codex to apply changes immediately. Policy enforced outside this bundle,
          such as device management, is not affected.
        </p>
        {save.isError && (
          <p role="alert" className="mt-4 rounded-lg bg-danger-dim px-3 py-2 text-xs text-danger">
            {save.error.message}
          </p>
        )}

        <div role="tablist" aria-label="Managed config" className="mt-6 flex border-b border-line">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-xs ${
                activeTab === id
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-content"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="pt-5">
          {activeTab === "workarounds" && (
            <div className="rounded-lg border border-line p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Browser use outside the ChatGPT app</p>
                <button
                  type="button"
                  role="switch"
                  aria-label="Browser use outside the ChatGPT app"
                  aria-checked={browserAccess}
                  disabled={save.isPending}
                  className={`toggle-switch ${browserAccess ? "on" : ""}`}
                  onClick={() => saveWorkaround(!browserAccess)}
                >
                  <span />
                </button>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">
                Temporary workaround for{" "}
                <a
                  className="text-accent underline"
                  href="https://github.com/openai/codex/issues/57641"
                  target="_blank"
                  rel="noreferrer"
                >
                  openai/codex#57641
                </a>
                . Since unified-computer-use 26.1023.50603, the plugin’s cua_repl preloads
                require-browser-access.mjs, which only the ChatGPT app can satisfy, so the Codex CLI
                and app-server hosts like T3 Code fail with “The browser access host is
                unavailable”. When on, crabex adds a cua_repl fragment without the preload,
                generated from the installed plugin, on top of the organisation’s bundle. Turn it
                off once upstream fixes the bug.
              </p>
              <p className="mt-2 text-xs text-muted">
                Status: {workaround?.status ?? "disabled"}
                {workaround?.version ? ` for version ${workaround.version}` : ""}
              </p>
            </div>
          )}

          {activeTab === "organisation" &&
            (upstream.isError ? (
              <p role="alert">{upstream.error.message}</p>
            ) : observed ? (
              <>
                <p className="text-xs text-muted">
                  Last fetched from ChatGPT {new Date(observed.fetchedAt).toLocaleString()}.
                </p>
                <BundlePreview bundle={observed.body} />
              </>
            ) : (
              <p className="text-sm text-muted">
                Not observed yet. crabex records it the next time Codex requests the bundle.
              </p>
            ))}

          {activeTab === "effective" && (
            <>
              <p className="text-xs text-muted">
                Fragments in the order Codex receives them, highest precedence first.
              </p>
              {stored.enabled && !localPolicyAllowed && (
                <p className="mt-2 text-xs text-warning">
                  A saved local policy is ignored because <code>local_policy_override</code> is off
                  in {proxyConfig.data?.path ?? "the crabex config file"}.
                </p>
              )}
              {effective.isError ? (
                <p role="alert">{effective.error.message}</p>
              ) : (
                effective.data && (
                  <BundlePreview
                    bundle={effective.data.bundle}
                    local={stored.enabled && localPolicyAllowed ? stored.bundle : {}}
                    workaroundId={workaround?.fragment?.id}
                  />
                )
              )}
            </>
          )}

          {activeTab === "local" && (
            <>
              <p className="text-xs leading-5 text-muted">
                For testing policy changes before publishing them upstream. While on, every Codex on
                this machine that goes through crabex gets these fragments instead of, or merged
                with, the organisation’s bundle.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 p-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-label="Serve local policy"
                    aria-checked={enabled}
                    onClick={() => setEnabled(!enabled)}
                    className={`toggle-switch ${enabled ? "on" : ""}`}
                  >
                    <span />
                  </button>
                  <span className="text-sm">Serve local policy</span>
                </div>
                <div className="flex gap-2" role="group" aria-label="Bundle mode">
                  {(["merge", "replace"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={pressable}
                      aria-pressed={mode === value}
                      onClick={() => setMode(value)}
                    >
                      {value === "merge" ? "Merge into upstream" : "Replace upstream"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted">
                {mode === "merge"
                  ? "Your fragments take precedence over the organisation’s; the same id replaces theirs."
                  : "Codex sees only your fragments; the organisation’s bundle is hidden."}
              </p>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2" role="group" aria-label="Editor">
                  {[...sections, "raw" as const].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={pressable}
                      aria-pressed={editorTab === value}
                      onClick={() => switchEditorTab(value)}
                    >
                      {value === "raw"
                        ? "Raw JSON"
                        : `${sectionLabel(value)} (${fragments(bundle, value).length})`}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-canvas hover:bg-accent-bright disabled:opacity-50"
                    disabled={save.isPending || !!error}
                    onClick={() =>
                      save.mutate({
                        version: 1,
                        enabled,
                        mode,
                        bundle: draft,
                        workarounds: {
                          ...stored.workarounds,
                          cua_repl_browser_access: browserAccess,
                        },
                      })
                    }
                  >
                    Save override
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={reset.isPending}
                    onClick={() => reset.mutate()}
                  >
                    Reset to passthrough
                  </button>
                </div>
              </div>
              {error && (
                <p role="alert" className="mt-3 text-xs text-danger">
                  {error}
                </p>
              )}
              {reset.isError && (
                <p role="alert" className="mt-3 text-xs text-danger">
                  {reset.error.message}
                </p>
              )}

              {editorTab === "raw" ? (
                <textarea
                  aria-label="Bundle JSON"
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setParseError("");
                  }}
                  className="input mt-4 min-h-72 font-mono text-xs"
                  spellCheck={false}
                />
              ) : (
                <FragmentList
                  key={editorTab}
                  section={editorTab}
                  list={fragments(bundle, editorTab)}
                  onChange={(next) => replaceFragments(editorTab, next)}
                />
              )}
              {served.map((entry) => (
                <p key={entry.action} className="mt-3 text-xs text-muted">
                  Served locally {entry.count}× · last {new Date(entry.lastSeenAt).toLocaleString()}
                </p>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function FragmentList({
  section,
  list,
  onChange,
}: {
  section: Section;
  list: Fragment[];
  onChange: (next: Fragment[]) => void;
}) {
  // Fragments start folded unless there is only one; newly added ones open for editing.
  const [opened, setOpened] = useState<Set<number>>(() => new Set(list.length === 1 ? [0] : []));
  const toggle = (index: number, open: boolean) =>
    setOpened((current) => {
      const next = new Set(current);
      if (open) next.add(index);
      else next.delete(index);
      return next;
    });
  const move = (index: number, offset: number) => {
    const next = [...list];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    onChange(next);
    setOpened(new Set());
  };
  return (
    <div className="mt-4 space-y-2">
      {list.map((fragment, index) => {
        const edit = (patch: Partial<Fragment>) =>
          onChange(list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
        return (
          <Fold
            key={index}
            open={opened.has(index)}
            onToggle={(open) => toggle(index, open)}
            title={fragment.name || fragment.id || "Untitled fragment"}
            detail={index === 0 ? "highest precedence" : `precedence ${index + 1}`}
          >
            <div className="grid gap-2 sm:grid-cols-2">
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
            </div>
            <TomlEditor
              label={`${section} fragment ${index + 1} TOML`}
              value={fragment.contents}
              onChange={(contents) => edit({ contents })}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className={button}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                className={button}
                disabled={index === list.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  onChange(list.filter((_, i) => i !== index));
                  setOpened(new Set());
                }}
              >
                Delete fragment
              </button>
            </div>
          </Fold>
        );
      })}
      <button
        type="button"
        className={button}
        onClick={() => {
          onChange([...list, { id: crypto.randomUUID(), name: "", contents: "" }]);
          toggle(list.length, true);
        }}
      >
        Add {sectionLabel(section)} fragment
      </button>
    </div>
  );
}

function Fold({
  title,
  detail,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  detail?: string;
  badge?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="group rounded-lg border border-line"
      open={open}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
        <span className="text-muted transition group-open:rotate-90">›</span>
        <span className="font-medium text-content">{title}</span>
        {detail && <span className="text-muted">{detail}</span>}
        {badge && (
          <span className="ml-auto rounded border border-line px-1 text-muted">{badge}</span>
        )}
      </summary>
      <div className="space-y-2 border-t border-line p-3">{children}</div>
    </details>
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
        ].filter((group) => group.items.length > 0);
        return (
          <div key={section} className="mt-4">
            <h3 className="section-label">{sectionLabel(section)}</h3>
            {groups.length === 0 && <p className="mt-1 text-xs text-muted">No fragments.</p>}
            {groups.map((group) => (
              <div key={group.label} className="mt-2 space-y-2">
                <p className="text-xs text-muted">{group.label}</p>
                {group.items.map((fragment, index) => (
                  <Fold
                    key={index}
                    title={fragment.name || fragment.id}
                    detail={fragment.name ? fragment.id : undefined}
                    badge={
                      local === undefined
                        ? undefined
                        : group.label === "enterprise_managed" && fragment.id === workaroundId
                          ? "workaround"
                          : group.label === "enterprise_managed" &&
                              fragments(local, section).some((item) => item.id === fragment.id)
                            ? "local"
                            : "upstream"
                    }
                  >
                    <TomlEditor
                      readOnly
                      label={`${section} ${group.label} observed ${index + 1} TOML`}
                      value={typeof fragment.contents === "string" ? fragment.contents : ""}
                    />
                  </Fold>
                ))}
              </div>
            ))}
          </div>
        );
      })}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted">Raw bundle JSON</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(bundle, null, 2)}
        </pre>
      </details>
    </div>
  );
}

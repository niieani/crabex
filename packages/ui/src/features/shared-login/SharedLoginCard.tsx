import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getSharedLogin, issueClientKey, putSharedLogin, revokeClientKey } from "../../lib/api.ts";
import type { ClientKeySummary, IssuedClientKey, SharedLoginState } from "../../lib/types.ts";

const QUERY_KEY = ["shared-login"];
const LOOPBACK = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

type Scope = "local" | "all" | "specific";

function splitListen(listen: string): { host: string; port: string } {
  const separator = listen.lastIndexOf(":");
  return {
    host: listen.slice(0, separator).replace(/^\[|\]$/g, ""),
    port: listen.slice(separator + 1),
  };
}

/** IPv6 addresses need brackets in a URL or before a port. */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function joinListen(host: string, port: string): string {
  return `${formatHost(host)}:${port}`;
}

function isLoopback(host: string): boolean {
  return host === LOOPBACK || host === "localhost" || host === "::1";
}

function scopeOf(host: string): Scope {
  if (isLoopback(host)) return "local";
  return host === ALL_INTERFACES || host === "::" ? "all" : "specific";
}

export function SharedLoginCard() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: getSharedLogin });
  const save = useMutation({
    mutationFn: putSharedLogin,
    onSuccess: (state) => client.setQueryData(QUERY_KEY, state),
  });
  const state = query.data;

  return (
    <section className="mt-8">
      <p className="section-label mb-3">Shared Login</p>
      {query.isError ? <p className="text-xs text-danger">{query.error.message}</p> : null}
      {state === undefined ? null : (
        <article className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold">Shared Login</h2>
            <button
              type="button"
              role="switch"
              aria-label="Shared Login"
              aria-checked={state.enabled}
              disabled={save.isPending || state.enabledOverride !== undefined}
              onClick={() => save.mutate({ enabled: !state.enabled })}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${state.enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"}`}
            >
              {state.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            Lets other Codex instances use this machine's ChatGPT login through issued keys, so they
            hold no ChatGPT credential and cannot reach your Apps. It runs on its own listener,
            which serves model traffic only and never this page. Its traffic is not captured,
            routed, or transformed.
          </p>
          {state.enabledOverride !== undefined ? (
            <p className="mt-2 text-xs text-muted">
              Set by a command-line override. Restart without --shared-login or --no-shared-login to
              edit this setting.
            </p>
          ) : null}
          <ListenerStatus state={state} />
          <LoginStatus login={state.login} />
          <Renewal
            state={state}
            pending={save.isPending}
            onToggle={() => save.mutate({ refresh: !state.refresh })}
          />
          <ListenSettings
            state={state}
            pending={save.isPending}
            onSave={(listen) => save.mutate({ listen })}
          />
          {save.isError ? <p className="mt-2 text-xs text-danger">{save.error.message}</p> : null}
          <ClientKeys state={state} />
        </article>
      )}
    </section>
  );
}

function ListenerStatus({ state }: { state: SharedLoginState }) {
  if (state.error !== undefined)
    return <p className="mt-3 text-xs text-danger">Could not listen: {state.error}</p>;
  if (!state.running) return null;
  return <p className="mt-3 font-mono text-[10px] text-muted">Listening on {state.origin}</p>;
}

function LoginStatus({ login }: { login: SharedLoginState["login"] }) {
  const ready = login.state === "ready";
  return (
    <div className="mt-3">
      <p className={`text-xs ${ready ? "text-muted" : "text-danger"}`}>
        {login.detail}
        {ready && login.expiresAt !== undefined
          ? `; access token valid until ${new Date(login.expiresAt).toLocaleString()}`
          : ""}
      </p>
      <p className="mt-1 font-mono text-[10px] text-muted">{login.path}</p>
    </div>
  );
}

function Renewal({
  state,
  pending,
  onToggle,
}: {
  state: SharedLoginState;
  pending: boolean;
  onToggle: () => void;
}) {
  const { lastRenewedAt, lastFailedAt, error } = state.renewal;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-xs font-semibold">Renew the login</h3>
        <button
          type="button"
          role="switch"
          aria-label="Renew the login"
          aria-checked={state.refresh}
          disabled={pending}
          onClick={onToggle}
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${state.refresh ? "bg-accent-dim text-accent" : "bg-canvas text-muted"}`}
        >
          {state.refresh ? "On" : "Off"}
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">
        While Shared Login is on, Crabex asks Codex to renew this login in its last day before
        expiry. Codex on this machine renews it sooner whenever you use it, and then Crabex has
        nothing to do. Turn this off if something else keeps the login fresh.
      </p>
      {error !== undefined && lastFailedAt !== undefined ? (
        <p className="mt-2 text-xs text-danger">
          Renewal failed {new Date(lastFailedAt).toLocaleString()}: {error}
        </p>
      ) : null}
      {lastRenewedAt !== undefined ? (
        <p className="mt-2 text-xs text-muted">
          Last renewed {new Date(lastRenewedAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}

function ListenSettings({
  state,
  pending,
  onSave,
}: {
  state: SharedLoginState;
  pending: boolean;
  onSave: (listen: string) => void;
}) {
  const saved = splitListen(state.listen);
  const [scope, setScope] = useState<Scope>(scopeOf(saved.host));
  const [address, setAddress] = useState(saved.host);
  const [port, setPort] = useState(saved.port);
  useEffect(() => {
    const next = splitListen(state.listen);
    setScope(scopeOf(next.host));
    setAddress(next.host);
    setPort(next.port);
  }, [state.listen]);

  const locked = state.listenOverride !== undefined;
  const host = scope === "local" ? LOOPBACK : scope === "all" ? ALL_INTERFACES : address;
  const options: Array<[Scope, string]> = [
    ["local", "This machine only"],
    ["all", "All interfaces"],
    ["specific", "Specific address"],
  ];

  return (
    <fieldset className="mt-4 border-t border-line pt-4" disabled={locked}>
      <legend className="sr-only">Listen address</legend>
      <div className="flex flex-wrap gap-4 text-xs">
        {options.map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="shared-login-scope"
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        {scope === "specific" ? (
          <label className="flex flex-col gap-1">
            Address
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="input font-mono text-xs"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          Port
          <input
            value={port}
            onChange={(event) => setPort(event.target.value)}
            className="input w-20 font-mono text-xs"
          />
        </label>
        <button
          type="button"
          disabled={locked || pending}
          onClick={() => onSave(joinListen(host.trim(), port.trim()))}
          className="rounded border border-line px-3 py-1 font-semibold disabled:opacity-50"
        >
          Save address
        </button>
      </div>
      {locked ? (
        <p className="mt-2 text-xs text-muted">
          Set by a command-line override. Restart without --shared-login-listen to edit this.
        </p>
      ) : null}
      {!isLoopback(host) && state.tls ? (
        <p className="mt-2 text-xs text-danger">
          The HTTPS certificate covers only localhost, so clients on other machines will reject it.
          Use a private network or an SSH tunnel.
        </p>
      ) : null}
      {!isLoopback(host) && !state.tls ? (
        <p className="mt-2 text-xs text-danger">
          Keys and model traffic will cross the network as plain HTTP. Use a private network or an
          SSH tunnel.
        </p>
      ) : null}
    </fieldset>
  );
}

function ClientKeys({ state }: { state: SharedLoginState }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<IssuedClientKey>();
  const issue = useMutation({
    mutationFn: issueClientKey,
    onSuccess: async (key) => {
      setIssued(key);
      setName("");
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-xs font-semibold">Client keys</h3>
      <form
        className="mt-3 flex flex-wrap items-end gap-3 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          issue.mutate(name);
        }}
      >
        <label className="flex flex-col gap-1">
          Key name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="input text-xs"
          />
        </label>
        <button
          type="submit"
          disabled={issue.isPending || name.trim() === ""}
          className="rounded border border-line px-3 py-1 font-semibold disabled:opacity-50"
        >
          Generate key
        </button>
      </form>
      {issue.isError ? <p className="mt-2 text-xs text-danger">{issue.error.message}</p> : null}
      {issued === undefined ? null : (
        <ClientSetup state={state} issued={issued} onDismiss={() => setIssued(undefined)} />
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {state.keys.map((key) => (
          <ClientKeyRow key={key.id} clientKey={key} />
        ))}
      </ul>
    </div>
  );
}

const CLIENT_KEY_FILE = "~/.config/crabex/client-key";

function clientKeyCommand(secret: string): string {
  return `(umask 077 && mkdir -p ~/.config/crabex && printf %s '${secret}' > ${CLIENT_KEY_FILE})`;
}

/**
 * A custom provider rather than `openai_base_url`: Codex offers its image tool to a provider that
 * sends `x-openai-actor-authorization`, which Crabex never forwards upstream.
 */
function clientConfig(baseUrl: string): string {
  return `model_provider = "crabex"

[model_providers.crabex]
name = "Crabex Shared Login"
base_url = "${baseUrl}"
model_catalog_url = "${baseUrl}/models"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
http_headers = { "x-openai-actor-authorization" = "crabex-shared-login" }

[model_providers.crabex.auth]
command = "sh"
args = ["-c", "cat ${CLIENT_KEY_FILE}"]`;
}

function ClientSetup({
  state,
  issued,
  onDismiss,
}: {
  state: SharedLoginState;
  issued: IssuedClientKey;
  onDismiss: () => void;
}) {
  const { host, port } = splitListen(state.listen);
  const visibleHost = scopeOf(host) === "all" ? "<this-host>" : formatHost(host);
  const scheme = state.tls ? "https" : "http";
  return (
    <div className="mt-3 rounded border border-line bg-canvas p-3 text-xs">
      <p className="font-semibold">Save this key now. It will not be shown again.</p>
      <div data-testid="client-setup">
        <p className="mt-2 text-muted">On the other machine, save the key:</p>
        <pre className="mt-1 overflow-x-auto font-mono text-[11px]">
          {clientKeyCommand(issued.secret)}
        </pre>
        <p className="mt-2 text-muted">Then add to ~/.codex/config.toml:</p>
        <pre className="mt-1 overflow-x-auto font-mono text-[11px]">
          {clientConfig(`${scheme}://${visibleHost}:${port}/v1`)}
        </pre>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 rounded border border-line px-3 py-1 font-semibold"
      >
        Dismiss
      </button>
    </div>
  );
}

function ClientKeyRow({ clientKey }: { clientKey: ClientKeySummary }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: revokeClientKey,
    onSuccess: (state) => client.setQueryData(QUERY_KEY, state),
  });
  return (
    <li className="flex items-center justify-between gap-3 text-xs">
      <span>
        <span className="font-semibold">{clientKey.name}</span>
        <span className="ml-2 text-muted">
          {clientKey.lastUsedAt === undefined
            ? "never used"
            : `last used ${new Date(clientKey.lastUsedAt).toLocaleString()}`}
        </span>
      </span>
      {confirming ? (
        <button
          type="button"
          aria-label={`Confirm revoke ${clientKey.name}`}
          disabled={revoke.isPending}
          onClick={() => revoke.mutate(clientKey.id)}
          className="rounded border border-line px-2 py-1 font-semibold text-danger disabled:opacity-50"
        >
          Confirm
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Revoke ${clientKey.name}`}
          onClick={() => setConfirming(true)}
          className="rounded border border-line px-2 py-1"
        >
          Revoke
        </button>
      )}
      {revoke.isError ? <span className="text-danger">{revoke.error.message}</span> : null}
    </li>
  );
}

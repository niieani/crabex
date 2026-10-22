# macOS background service

The CLI can install a per-user LaunchAgent. It starts at login after reboot and launchd restarts it if it exits. It uses the existing user account; no root access or new ChatGPT login is required.

Build the CLI and UI, then install:

```sh
vp run build
bun packages/proxy/dist/cli.mjs service install
```

If port 8765 is occupied by an unmanaged proxy, installation stops before changing it. To try the service alongside that proxy:

```sh
bun packages/proxy/dist/cli.mjs service install -- --listen 127.0.0.1:8766
```

Switch Codex's endpoint settings only after checking the new service. To retain the original port, perform the migration with the independent restart procedure in `AGENTS.md`; the installer deliberately does not kill an unmanaged listener. Default data is copied on first installation, so avoid concurrent writes during migration. Explicit proxy path options stay at their resolved absolute paths.

The installed command lives at:

```sh
"$HOME/Library/Application Support/crabex/bin/crabex" service status
```

Add that `bin` directory to your shell's PATH if desired. Supported commands:

| Command             | Behavior                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `service install`   | Install or stage an updated build; retain existing service arguments on updates unless `--` options are supplied. |
| `service restart`   | Start an independent worker to restart the installed release and check readiness.                                 |
| `service status`    | Show launchd process state and HTTP readiness without printing environment credentials.                           |
| `service logs`      | Print the last 80 lines of proxy stdout/stderr and the location of restart result logs.                           |
| `service uninstall` | Unload the LaunchAgent and remove registration; preserve data, releases, and logs.                                |

Install and restart return once the worker acknowledges startup, **before readiness is known**. The worker survives loss of the calling Codex connection. It owns stop/start, checks that the launchd PID owns the port and the local API responds, and restores the previous release if an update fails. Because launchd can finish unloading asynchronously, bootstrap error 5 is retried for up to five seconds before rollback. Restart errors retain the underlying diagnostic in the result log. Inspect its result log and `service status` afterward. First-install failure removes the registration. A restart uses the same release for recovery; it cannot fix an invalid configuration or unavailable runtime. Interrupted operations leave a lock under the installation directory; inspect worker logs/processes before removing a stale lock.

The installation contains a copied Bun runtime and bundled CLI under `~/Library/Application Support/crabex/releases/`. Default proxy data lives under `data/`, the LaunchAgent plist under `~/Library/LaunchAgents/`, and logs under `~/Library/Logs/crabex/`. Existing releases and logs are retained for manual inspection; automatic pruning/rotation is not yet implemented.

LaunchAgents do not inherit your interactive shell setup. Pass environment variable **names** when installing routes that require them:

```sh
bun packages/proxy/dist/cli.mjs service install --env MY_PROVIDER_TOKEN
```

Only explicitly selected variables plus HOME and PATH are configured. Existing selected values survive updates; repeat `--env NAME` to refresh a value. Values are stored locally in files restricted to the user, including the plist and operation records. ChatGPT bearer tokens are not copied from Codex: the Apps relay still learns those from live authenticated Codex traffic. Existing Codex config path selection is preserved as an absolute path.

Uninstall does not rewrite Codex endpoint settings. Point Codex at a working endpoint before removing a service it depends on.

## Upgrading from agent-context-trimmer

A service installed under the former name (`com.agent-context-trimmer.proxy`) is
migrated by the next `service install`. See [upgrading.md](upgrading.md) for
what moves, how rollback works, and the verification checklist.

## Local HTTPS and Keychain trust

Recent ChatGPT desktop versions require an HTTPS workspace backend. Install managed
HTTPS with:

```sh
vp run build
bun packages/proxy/dist/cli.mjs service install --https
```

The installer generates a unique local CA and a server certificate valid for
`localhost`, `127.0.0.1`, and `::1`. It installs SSL trust in the current user's
login Keychain. macOS may request authorization; no sudo or System Keychain change
is used. This trust is available to applications using the user's trust store,
not exclusively to this proxy.

Some installations configure a custom CA bundle through `CODEX_CA_CERTIFICATE` or
`SSL_CERT_FILE`. The installer detects that configuration without assuming a
particular enterprise product or certificate path. When present, it creates a
private bundle containing the configured roots plus the managed local CA, then
publishes its path as `CODEX_CA_CERTIFICATE` in the current user's launchd
environment. Codex gives that variable precedence, while the ChatGPT desktop app
continues to use login-Keychain trust. With no custom CA bundle, the installer does
not change the launchd environment. Each update stages a separate bundle without
changing the roots used by the running installation. After readiness succeeds, the worker publishes the new
bundle path. Rollback restores the previous service's bundle; uninstall restores
the original user value. Both leave a concurrently changed value untouched.
New terminals and apps inherit the current bundle path after publication. Existing shells keep
their earlier value; the installer retains the current bundle, the rollback bundle, any path still
published in launchd, the three newest bundles, and every bundle modified within the last seven
days. Older unreferenced bundles are removed after a successful install or restart. A user
override outside the managed bundle directory remains untouched.

The original external CA source path is recorded in service state. Reinstallation
reads that source again, even when the installer inherits a managed
`CODEX_CA_CERTIFICATE`, so enterprise-root rotations are picked up without
appending the local CA repeatedly. No shell startup files are edited. Legacy
installations recover the source from external CA variables when possible; if
none is available, installation asks for an explicit external bundle rather than
using generated output as input. To choose a different source, set the relevant
variable and pass `--env SSL_CERT_FILE` or `--env CODEX_CA_CERTIFICATE`.

After the independent worker verifies HTTPS readiness, `--https` enables both
managed Codex endpoint settings using the HTTPS origin. Existing values are
preserved in the usual comment fences. If startup fails, the previous service
and any endpoint edits made by this operation are restored. If config.toml changes
while installation is running, migration aborts rather than overwriting those
edits. Fully restart ChatGPT afterward to use its new endpoints. Existing clients
holding an HTTP URL will not work against a listener converted to HTTPS.

Certificates and private keys live under the installation's `tls/` directory,
outside versioned releases. The CA lasts ten years; server certificates last 825
days, the longest macOS accepts for any TLS server certificate. Updates reuse
certificates until their last 30 days, when installation stages a renewal. There
is no background renewal job: use the CLI before expiry.
Setup in the web UI shows the expiry, renewal warning, and Keychain validation.

```sh
crabex service tls status
crabex service tls renew
```

Renewal preserves the CA and stages a new certificate directory, then restarts
through the independent worker. The previous certificate remains available for
rollback. `service install --https` also repairs missing Keychain trust. CA
rotation near the end of its lifetime requires uninstalling and reinstalling
HTTPS; the CLI reports this instead of silently replacing the trusted CA.

`service uninstall` removes only this installation's CA trust, certificate, and
TLS directory, identified by its recorded SHA-256 fingerprint. Other Keychain
certificates are left unchanged. To clean up TLS files after an interrupted setup:

```sh
crabex service tls remove
```

Removal refuses while an installed service is configured to use TLS. Uninstall
does not rewrite Codex URLs; change those before uninstalling a service you use.

For a manually launched proxy, `proxy --tls-dir <directory>` accepts `cert.pem`,
`key.pem`, and `ca.pem`. It does not install trust. The service installer owns its
certificates and uses `--https` instead of accepting custom `--tls-dir` options.

The Crabex UI is included in each service release and served on the proxy's
own origin (for example `https://127.0.0.1:8765`). No separate UI server, port,
or proxy-origin environment variable is required. Rebuild both packages with
`vp run build` before installing an updated release.

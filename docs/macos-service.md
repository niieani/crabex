# macOS background service

The CLI can install a per-user LaunchAgent. It starts at login after reboot and launchd restarts it if it exits. It uses the existing user account; no root access or new ChatGPT login is required.

Build the CLI, then install:

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
"$HOME/Library/Application Support/agent-context-trimmer/bin/agent-context-trimmer" service status
```

Add that `bin` directory to your shell's PATH if desired. Supported commands:

| Command             | Behavior                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `service install`   | Install or stage an updated build; retain existing service arguments on updates unless `--` options are supplied. |
| `service restart`   | Start an independent worker to restart the installed release and check readiness.                                 |
| `service status`    | Show launchd process state and HTTP readiness without printing environment credentials.                           |
| `service logs`      | Print the last 80 lines of proxy stdout/stderr and the location of restart result logs.                           |
| `service uninstall` | Unload the LaunchAgent and remove registration; preserve data, releases, and logs.                                |

Install and restart return once the worker acknowledges startup, **before readiness is known**. The worker survives loss of the calling Codex connection. It owns stop/start, checks that the launchd PID owns the port and the local API responds, and restores the previous release if an update fails. Inspect its result log and `service status` afterward. First-install failure removes the registration. A restart uses the same release for recovery; it cannot fix an invalid configuration or unavailable runtime. Interrupted operations leave a lock under the installation directory; inspect worker logs/processes before removing a stale lock.

The installation contains a copied Bun runtime and bundled CLI under `~/Library/Application Support/agent-context-trimmer/releases/`. Default proxy data lives under `data/`, the LaunchAgent plist under `~/Library/LaunchAgents/`, and logs under `~/Library/Logs/agent-context-trimmer/`. Existing releases and logs are retained for manual inspection; automatic pruning/rotation is not yet implemented.

LaunchAgents do not inherit your interactive shell setup. Pass environment variable **names** when installing routes that require them:

```sh
bun packages/proxy/dist/cli.mjs service install --env MY_PROVIDER_TOKEN
```

Only explicitly selected variables plus HOME and PATH are configured. Existing selected values survive updates; repeat `--env NAME` to refresh a value. Values are stored locally in files restricted to the user, including the plist and operation records. ChatGPT bearer tokens are not copied from Codex: the Apps relay still learns those from live authenticated Codex traffic. Existing Codex config path selection is preserved as an absolute path.

Uninstall does not rewrite Codex endpoint settings. Point Codex at a working endpoint before removing a service it depends on.

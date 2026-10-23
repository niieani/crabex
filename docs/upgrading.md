# Upgrading from agent-context-trimmer

Crabex was previously called **agent-context-trimmer** (and briefly branded
Relaydeck). The rename has no compatibility aliases: old command names, data
paths, API paths, and the LaunchAgent label are gone. Instead, Crabex migrates
existing state once, the first time it runs.

| Old                                                                   | New                                             | Migrated by                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `./.agent-context-trimmer/`                                           | `./.crabex/`                                    | `crabex proxy` or `crabex service install`, in that working directory |
| `# >>> agent-context-trimmer:<key> >>>` fences in Codex `config.toml` | `# >>> crabex:<key> >>>`                        | `crabex proxy` and `crabex service install`                           |
| LaunchAgent `com.agent-context-trimmer.proxy`                         | `com.crabex.proxy`                              | `crabex service install`                                              |
| `~/Library/Application Support/agent-context-trimmer/`                | `~/Library/Application Support/crabex/`         | `crabex service install`                                              |
| `~/Library/Logs/agent-context-trimmer/`                               | `~/Library/Logs/crabex/`                        | `crabex service install` (old logs are removed)                       |
| `agent-context-trimmer`, `relaydeck` commands                         | `crabex`                                        | not migrated; update scripts and PATH                                 |
| `/__agent-context-trimmer/api/*`                                      | `/__crabex/api/*`                               | not migrated; update scripts                                          |
| `RELAYDECK_MANAGED_SERVICE`, `ACT_PROXY_ORIGIN`                       | `CRABEX_MANAGED_SERVICE`, `CRABEX_PROXY_ORIGIN` | not migrated                                                          |

Codex endpoint URLs (`openai_base_url`, `chatgpt_base_url`) do not change; the
listener keeps its port.

## Instructions for an agent performing the upgrade

Follow these steps in order. Stop and report if any check fails; do not delete
legacy state by hand.

1. **Find what is installed.**
   - Service: check whether `~/Library/Application Support/agent-context-trimmer/service.json`
     exists. If it does, a legacy service is installed; note `origin` and
     `args` from that file. Never print its `environment` values; they may hold
     credentials.
   - Manual proxy: look for a running `cli.mjs proxy` process and its working
     directory (`lsof -nP -iTCP -sTCP:LISTEN`, then `lsof -p <pid> | grep cwd`).
2. **Check whether your own session depends on the proxy.** If you are running
   inside Codex and its `openai_base_url` or `chatgpt_base_url` points at the
   listener, every model call you make goes through it. Follow "Restarting a
   proxy from Codex" in [AGENTS.md](../AGENTS.md): the steps below that stop the
   proxy must run without another model response in between.
3. **Build the new version** in the checkout:
   ```sh
   git pull && vp install && vp run build
   ```
4. **Migrate.**
   - **Service:** run `./packages/proxy/dist/cli.mjs service install` from the
     checkout. Pass no proxy options, so the existing arguments are reused; add
     `--https` only if the legacy service already used HTTPS and you want the
     installer to rewrite Codex's endpoint settings. Re-pass `--env NAME` only
     to refresh a value. The installer copies legacy data, certificates, and the
     Codex CA bundle to the new location, then starts an independent worker that
     stops the legacy LaunchAgent, re-syncs data written meanwhile, starts
     `com.crabex.proxy`, waits for readiness, and removes the legacy directory
     and logs. If startup fails, the worker restarts the legacy release
     unchanged.
   - **Manual proxy:** stop it, then start `crabex proxy` (the built
     `./packages/proxy/dist/cli.mjs proxy`) from the same working directory with
     the same options. It renames `.agent-context-trimmer/` to `.crabex/` and
     prints a notice to stderr. If both directories exist, it uses `.crabex/`,
     leaves the legacy one in place, and warns; merge them manually.
5. **Verify.**
   - The worker result log path is printed by `service install`; it should end
     with `Migrated legacy com.agent-context-trimmer.proxy service` and
     `Service ready`.
   - `crabex service status` (installed at
     `~/Library/Application Support/crabex/bin/crabex`) reports `state = running`
     and `HTTP readiness: ready`.
   - `curl <origin>/__crabex/api/proxy-config` returns JSON with `"version": 1`.
     For HTTPS, pass `--cacert` with the service's `ca.pem`, or open the UI in
     a browser.
   - `launchctl print gui/$(id -u)/com.agent-context-trimmer.proxy` fails (the
     legacy job is gone) and `~/Library/LaunchAgents/com.agent-context-trimmer.proxy.plist`
     no longer exists.
   - Codex `config.toml` contains `crabex:` fences and no `agent-context-trimmer:`
     ones.
   - `launchctl getenv CODEX_CA_CERTIFICATE`, if set, points under
     `~/Library/Application Support/crabex/tls/`.
6. **Clean up references.** Replace `agent-context-trimmer` or `relaydeck` in
   shell PATH entries, aliases, and scripts with `crabex`, and API calls with
   `/__crabex/api`. Fully quit and reopen every app that hosts Codex (ChatGPT
   Desktop, T3 Code, IDE extensions, terminals running `codex`) so each picks up
   the new `CODEX_CA_CERTIFICATE` path. A Codex process started before the
   migration keeps the deleted legacy path: it cannot fetch workspace-managed
   policies, and Computer Use and Browser Use fail with
   `Failed to load cloud config bundle (workspace-managed policies)`.

## Rollback

If the worker rolled back, the legacy release keeps running under the new
`com.crabex.proxy` label, with its data still under the legacy directory.
Fix the reported problem and run `service install` again; it retries the
migration. To return to an old build entirely, run `crabex service uninstall`,
check out a commit from before the rename, and run its `service install`.

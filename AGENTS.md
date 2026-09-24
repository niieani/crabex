<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp run test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## References

- Flex routes (half-price Batch rates, `-flex` failover, prompt cache lost on tier switch): `docs/flex-routes.md`.
- Codex source is cloned on this machine; pull latest main and inspect it before relying on Codex docs.
- Tests need Bun-native APIs: run `vp run test`, not bare `vp test`.
- Monorepo packages: `packages/proxy` (Bun CLI/server) and `packages/ui` (React/Tailwind UI).

## Local infrastructure

Keep machine-specific route configuration, private upstream URLs, internal hostnames, and their related notes or examples in the gitignored `.agent-context-trimmer/` directory alongside local configuration. Use reserved example domains in tracked tests and documentation. Before committing or pushing, check staged files for private infrastructure details; if one entered Git history, remove it from the affected history before publishing.

## Live OAuth test

- Build with `vp run build`; put logs/captures under `temp.local/$(date +%F)/`.
- Start `./packages/proxy/dist/cli.mjs proxy` on an unused localhost port, preferably in tmux.
- Run `codex exec --ephemeral --model <model> -c 'model_reasoning_effort="<effort>"' -c 'openai_base_url="http://127.0.0.1:<port>/backend-api/codex"' 'Reply with exactly: audit-ok'` using the existing ChatGPT login—never an API key.
- For V2 subagent tests, use a persistent isolated `CODEX_HOME` and omit `--ephemeral`; ephemeral spawn fails with `no thread with id`.
- `codex exec` launched from Codex Desktop may inherit Desktop originator identity; trust captured harness metadata, and run outside Desktop when specifically validating TUI scope.
- Inspect NDJSON with `jq`: confirm WebSocket `response.create`, requested model/effort, `generate:false` warmup, chained `previous_response_id`, and `response.completed`.
- Stop the proxy after verification.

## Restarting a proxy from Codex

Codex may depend on the proxy being restarted for its own model and tool requests. A stop can prevent the next tool call from ever running.

1. Before stopping anything, inspect the active Codex config (`$CODEX_HOME/config.toml`, falling back to `~/.codex/config.toml`), including selected profiles/provider settings and known command-line overrides. Compare `openai_base_url`, `chatgpt_base_url`, and provider `base_url` endpoints with the target listener; treat localhost aliases as equivalent. If either route uses this instance, or the effective route is uncertain, assume the current Codex session depends on it. Read only relevant settings; keep credentials out of output.
2. Identify the listener's PID, supervisor/tmux session, exact launch arguments, working directory, and required environment. Build and validate the replacement before stopping the working instance; retain a runnable previous build for recovery.
3. When running as Codex, prepare a single restart script that stops the identified instance, waits for the port to be released, starts the replacement with the preserved settings, polls readiness with a deadline, and restores the previous build if startup fails. The entire sequence must run without another model response or tool call. Launch it independently of the target process/session (for example, in a separate detached tmux session with logs redirected to a file), and verify that the restart worker is running before it stops the proxy. A single tool call alone does not make the worker independent.
4. For an installed LaunchAgent, use `service restart`; see `docs/macos-service.md` for worker logs, readiness checks, updates, and migration. For tmux, create the replacement session explicitly: stopping the proxy may also terminate its shell, pane, and the last tmux session. Do not depend on sending a later command to the old pane. For a supervised service, let its supervisor restart it and keep readiness/recovery in the independent script.
5. After connectivity returns, verify the new PID owns the intended port and `GET /__agent-context-trimmer/api/proxy-config` succeeds with the expected settings. Inspect the restart log before declaring success. Keep the same Codex URLs; switching them is a separate change.

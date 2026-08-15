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

- Current Codex source: `/Volumes/Projects/SoftwareReferences/codex`; inspect it before relying on Codex docs.
- Tests need Bun-native APIs: run `vp run test`, not bare `vp test`.
- Monorepo packages: `packages/proxy` (Bun CLI/server) and `packages/ui` (React/Tailwind UI).

## Live OAuth test

- Build with `vp run build`; put logs/captures under `temp.local/$(date +%F)/`.
- Start `./packages/proxy/dist/cli.mjs proxy` on an unused localhost port, preferably in tmux.
- Run `codex exec --ephemeral --model <model> -c 'model_reasoning_effort="<effort>"' -c 'openai_base_url="http://127.0.0.1:<port>/backend-api/codex"' 'Reply with exactly: audit-ok'` using the existing ChatGPT login—never an API key.
- `codex exec` launched from Codex Desktop may inherit Desktop originator identity; trust captured harness metadata, and run outside Desktop when specifically validating TUI scope.
- Inspect NDJSON with `jq`: confirm WebSocket `response.create`, requested model/effort, `generate:false` warmup, chained `previous_response_id`, and `response.completed`.
- Stop the proxy after verification.

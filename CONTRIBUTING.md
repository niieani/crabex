# Contributing to Crabex

Bug reports, documentation improvements, and focused pull requests are welcome.
For a substantial feature or behavior change, open an issue first to discuss the
problem and proposed approach. Report vulnerabilities using [SECURITY.md](SECURITY.md).

## Local development

Install [Vite+](https://viteplus.dev), then run from the repository root:

```sh
vp install
vp run dev
```

The project uses Bun APIs and Vite+ tooling. `packages/proxy` contains the server
and CLI; `packages/ui` contains the React UI. Read [AGENTS.md](AGENTS.md) for
repository conventions and [CONTEXT.md](CONTEXT.md) for domain terminology.

Before submitting a pull request, run:

```sh
vp check
vp run test
vp run build
```

Use `vp run test`, rather than bare `vp test`, so tests run with Bun's native
APIs. Add regression coverage when changing behavior, and update documentation
when changing configuration, CLI options, or installation steps. Live upstream
tests require your own existing login or provider credentials; the ordinary test
suite should work without them.

## Pull requests and reports

Keep changes focused. Explain the problem, resulting behavior, and validation
performed. Use Conventional Commit titles such as `fix: handle missing route
tokens`, `feat: add route diagnostics`, or `docs: clarify setup`; release-please
uses these to determine version bumps and generate release notes. Mark breaking
changes with `!` and explain the migration.

For bug reports, include the Crabex version or commit, operating system, Bun and
Codex versions, steps to reproduce, and expected versus observed behavior. Share
only a minimal, sanitized reproduction.

## Private data

Keep machine-specific routes, upstream URLs, credentials, and local notes under
the gitignored `.crabex/` directory. Put temporary logs and captures under
`temp.local/`. Captures can contain prompts, source code, tool results, and other
private content even when headers are omitted. Do not attach raw captures to
issues or pull requests. Use reserved example domains such as `example.com` in
tracked fixtures and documentation, and inspect your diff for private data before
submitting it.

Contributions are made under the project's [MIT license](LICENSE). Preserve
required third-party notices when incorporating external code.

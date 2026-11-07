# Security policy

## Reporting a vulnerability

Email [npm@invent.life](mailto:npm@invent.life) with the subject
`Crabex security report`. This is the maintainer's published project contact.
Please report exploitable security issues privately rather than opening a public
issue with vulnerability details.

Include the affected version or commit, impact, prerequisites, and minimal steps
to reproduce. Use synthetic data and redact tokens, cookies, private upstream
URLs, prompts, and personal information. Do not send raw captures or credentials.
Coordinate disclosure with the maintainer while a fix is investigated; response
times are not guaranteed.

## Supported versions

Security fixes target the latest released version. Older releases do not have a
separate maintenance commitment. Until the first release, use the latest commit
on the default branch.

## Deployment assumptions

Crabex is intended for a trusted, single-user machine and binds to loopback by
default. Its local UI and API expose sensitive configuration and captured
traffic. Treat access to the listener, its data directory, and the user account
running it as privileged access. Read the [Apps relay limitations](docs/apps-auth-relay.md)
before exposing the listener beyond localhost.

[Shared Login](docs/shared-login.md), off by default, is the one listener meant for other
machines. It treats every Client Key holder as untrusted: an allowlist of backend paths, tool
types, headers, and query parameters, with no access to the UI, local API, captures, or the
login itself. Anyone holding a key can spend the host account's usage, so issue one key per
client and revoke keys you no longer need.

Request captures may contain prompts, source code, tool results, and other private
content. Owner-only capture permissions and omitted headers do not make those
files safe to publish. Keep route secrets in the configured environment
variables, keep local configuration under `.crabex/`, and sanitize diagnostic
material before sharing it.

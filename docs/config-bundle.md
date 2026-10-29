# Managed configuration bundles

Advanced lets you edit TOML fragments in the managed config bundle. Merge mode
fetches the organisation's bundle on each request and places your fragments first,
in highest precedence order. A local fragment replaces an upstream fragment with
the same id within its section. Unknown upstream fields pass through. If upstream
fails or takes more than ten seconds, crabex uses its last observed bundle, or an
empty bundle if none was observed; your local fragments remain available.

Replace mode serves only the local bundle, while observing upstream in the
background. Existing overrides without a mode retain replace behavior. Reset to
passthrough disables the override.

The editor validates TOML and requires non-empty, unique ids within each section.
The raw JSON tab preserves access to the full bundle, including unknown fields.
The effective preview uses the saved override and last observed upstream bundle;
it never fetches upstream. In merge mode a subsequent request may observe a newer
upstream bundle.

Codex only fetches managed bundles for business, enterprise, and edu ChatGPT plans.
Running Codex processes refresh them about every 15 minutes. Restart Codex to apply
changes immediately; this feature does not bypass the plan gate.

## Temporary browser access workaround

“Browser use outside the ChatGPT app” is a temporary workaround for
[openai/codex#57641](https://github.com/openai/codex/issues/57641). Since
unified-computer-use 26.1023.50603, its cua_repl preloads
require-browser-access.mjs, which only the ChatGPT app can satisfy; Codex CLI and
app-server hosts such as T3 Code fail with “The browser access host is unavailable”.

Enable the dedicated toggle and save. It works even when the general override is
disabled: crabex merges just the generated workaround into the organisation's
bundle. In either override mode, its generated fragment has highest precedence.
The effective preview labels it “workaround” and reports whether it is active for
a version, unnecessary, or the plugin was not found.

On each request crabex reads the newest numerically versioned installed plugin's
.mcp.json and copies cua_repl's Codex configuration, removing only the
require-browser-access.mjs import pair and a null cwd. Other imports, tool settings,
enabled, omit_tools_from, and environment settings remain intact. It checks
$CODEX_HOME first, then the directory of --codex-config, then ~/.codex, so plugin
updates require no manual copying. Missing plugins or a removed preload produce
no workaround fragment. This changes neither the plugin nor Codex's local config.
Turn the toggle off once upstream fixes the issue.

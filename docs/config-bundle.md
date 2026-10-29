# Managed configuration bundles

On business, enterprise and edu ChatGPT plans, Codex fetches a managed config
bundle and loads its fragments as a layer between `/etc/codex` and
`~/.codex/config.toml`. Running Codex processes refresh it about every 15
minutes; restart Codex to apply a change immediately. crabex does not bypass the
plan gate, and policy enforced outside this bundle (for example, device
management) is unaffected.

Advanced has four tabs:

- **Workarounds**: switches that add generated fragments on top of the
  organisation's bundle. They save immediately.
- **Organisation bundle**: the last bundle crabex observed from ChatGPT,
  including `managed_layers`, read-only.
- **What Codex receives**: the bundle the next request would get, highest
  precedence first, with each fragment marked `local`, `upstream` or
  `workaround`. It uses the last observed upstream bundle and never fetches.
- **Local policy**: hidden unless the crabex config file allows it (below).

## Local policy

A local policy lets you test managed-config changes on this machine before
publishing them upstream. Because it can outrank or hide the organisation's
policy, it is off unless the proxy config file (`config.json`, shown on the
Connection page) contains:

```json
{ "version": 1, "local_policy_override": true }
```

Restart crabex after editing the file. The local API refuses to change this
flag, and while it is off crabex ignores any saved local policy. Starting crabex
with a saved, enabled local policy from an earlier version sets the flag once,
so existing setups keep working.

- **Merge into upstream** fetches the organisation's bundle on each request and
  places your fragments first. A local fragment replaces an upstream fragment
  with the same id within its section; unknown upstream fields pass through. If
  upstream fails or takes more than ten seconds, crabex uses its last observed
  bundle, or an empty one; your fragments still apply.
- **Replace upstream** serves only your fragments, observing upstream in the
  background so the Organisation bundle tab stays current. Saved policies
  without a mode keep replace behaviour.

The editor validates TOML and requires non-empty, unique ids within each
section. Raw JSON gives access to the full bundle, including unknown fields.
Reset to passthrough turns the local policy off.

## Temporary browser access workaround

“Browser use outside the ChatGPT app” is a temporary workaround for
[openai/codex#57641](https://github.com/openai/codex/issues/57641). Since
unified-computer-use 26.1023.50603, its cua_repl preloads
require-browser-access.mjs, which only the ChatGPT app can satisfy; Codex CLI and
app-server hosts such as T3 Code fail with “The browser access host is unavailable”.

Turn on the switch in the Workarounds tab. It works without a local policy:
crabex merges just the generated workaround into the organisation's bundle.
With a local policy in either mode, the workaround fragment has highest
precedence.
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

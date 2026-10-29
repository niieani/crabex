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

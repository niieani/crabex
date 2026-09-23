# Refresh the built-in model catalog

The proxy's built-in catalog is `packages/proxy/src/routing/models-fixture.json`. It is a snapshot of Codex's local `~/.codex/models_cache.json`, used as a template for model routes and for pinned model definitions. The proxy does not read the local cache file at runtime.

The cache has a top-level `identity` value tied to the local account. Remove it before copying the cache into the repository. Keep the rest of the cache metadata and model definitions.

From the repository root:

1. Check the working tree, fetch remote changes, and rebase if the branch is behind. Run `vp install` after bringing in remote changes.
2. Refresh the fixture without the account identity:

   ```sh
   jq 'del(.identity)' "$HOME/.codex/models_cache.json" > packages/proxy/src/routing/models-fixture.json
   vp check --fix
   ```

3. Check the catalog and update the model-count and slug assertions in `packages/proxy/src/routing/models-fixture.test.ts` if the list changed:

   ```sh
   jq -e 'has("identity") | not' packages/proxy/src/routing/models-fixture.json
   jq -r '.models[].slug' packages/proxy/src/routing/models-fixture.json
   diff -u <(jq -S '.models' "$HOME/.codex/models_cache.json") <(jq -S '.models' packages/proxy/src/routing/models-fixture.json)
   ```

4. Review `git diff`, then run `vp check` and `vp run test`. Commit and push the fixture and any updated assertions.

The local `GET /__agent-context-trimmer/api/models-fixture` endpoint returns `{ "models": [...] }` from the fixture, so it does not expose the cache's top-level metadata. The proxied `GET /backend-api/codex/models` endpoint uses the live upstream response; it preserves top-level upstream fields when passing through or transforming that response. The local cache's `identity` is not added to either endpoint by the fixture.

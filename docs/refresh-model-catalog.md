# Refresh the built-in model catalog

The proxy's built-in catalog is `packages/proxy/src/routing/models-fixture.json`.
It is a copy of the [official Codex model catalog](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json),
used as a template for model routes and for pinned model definitions. The proxy
does not read `~/.codex/models_cache.json` at runtime. That cache may contain
account-specific metadata and locally advertised proxy routes, so it is not a
source for the bundled catalog.

From the repository root:

1. Check the working tree, fetch remote changes, and rebase if the branch is behind. Run `vp install` after bringing in remote changes.
2. Fetch the official catalog and validate its shape:

   ```sh
   curl -fL https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json \
     -o packages/proxy/src/routing/models-fixture.json
   jq -e 'keys == ["models"] and (.models | type == "array") and (.models | all(.slug | type == "string"))' \
     packages/proxy/src/routing/models-fixture.json
   ```

3. Check the catalog and update the model-count and slug assertions in `packages/proxy/src/routing/models-fixture.test.ts` if the list changed:

   ```sh
   jq -r '.models[].slug' packages/proxy/src/routing/models-fixture.json
   ```

4. Review `git diff`, then run `vp check` and `vp run test`.

The official file is excluded from Oxfmt so that its bytes remain identical to
the published catalog.

The local `GET /__crabex/api/models-fixture` endpoint returns
`{ "models": [...] }` from the fixture. The proxied
`GET /backend-api/codex/models` endpoint uses the live upstream response and
preserves top-level upstream fields when passing through or transforming it.

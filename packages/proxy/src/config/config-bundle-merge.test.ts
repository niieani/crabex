import { describe, expect, it } from "vite-plus/test";
import { mergeConfigBundles } from "./config-bundle-merge.ts";

const fragment = (id: string) => ({ id, name: id, contents: "enabled = true" });
describe("mergeConfigBundles", () => {
  it("keeps local precedence and order, replaces matching ids independently per section", () => {
    const upstream = {
      config_toml: { enterprise_managed: [fragment("b"), fragment("c")] },
      requirements_toml: { enterprise_managed: [fragment("a")] },
    };
    const local = {
      config_toml: {
        enterprise_managed: [fragment("a"), { ...fragment("b"), contents: "enabled = false" }],
      },
    };
    const original = structuredClone(upstream);
    expect(mergeConfigBundles(upstream, local)).toEqual({
      config_toml: { enterprise_managed: [...local.config_toml.enterprise_managed, fragment("c")] },
      requirements_toml: upstream.requirements_toml,
    });
    expect(upstream).toEqual(original);
  });
  it("preserves unknown upstream keys and null or missing untouched sections", () => {
    const upstream = {
      future: { keep: true },
      config_toml: { future: 7, enterprise_managed: null },
      requirements_toml: null,
    };
    expect(
      mergeConfigBundles(upstream, { config_toml: { enterprise_managed: [fragment("a")] } }),
    ).toEqual({
      ...upstream,
      config_toml: { future: 7, enterprise_managed: [fragment("a")] },
    });
    expect(mergeConfigBundles(upstream, {})).toEqual(upstream);
    expect(mergeConfigBundles({}, { config_toml: null })).toEqual({});
  });
  it("handles empty upstream and missing or null sections", () => {
    const local = { config_toml: { enterprise_managed: [fragment("a")] } };
    for (const upstream of [
      null,
      undefined,
      {},
      { config_toml: null },
      { config_toml: {} },
      { config_toml: { enterprise_managed: null } },
    ]) {
      expect(mergeConfigBundles(upstream, local)).toEqual(local);
    }
    expect(mergeConfigBundles(null, null)).toEqual({});
  });
});

it("passes managed_layers through untouched while merging only enterprise_managed", () => {
  const managed_layers = { baseline: [fragment("baseline")], system_overlay: [fragment("system")] };
  const upstream = {
    config_toml: { managed_layers, enterprise_managed: [fragment("remote")] },
    requirements_toml: { managed_layers },
  };
  expect(
    mergeConfigBundles(upstream, { config_toml: { enterprise_managed: [fragment("local")] } }),
  ).toEqual({
    config_toml: { managed_layers, enterprise_managed: [fragment("local"), fragment("remote")] },
    requirements_toml: { managed_layers },
  });
});

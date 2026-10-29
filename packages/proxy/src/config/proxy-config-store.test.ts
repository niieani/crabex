import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openProxyConfigStore, parseProxyConfig } from "./proxy-config-store.ts";

describe("proxy config", () => {
  it("defaults the relay on and persists an opt-out with change notifications", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "act-proxy-config-")), "config.json");
    const store = await openProxyConfigStore(path);
    expect(store.get()).toEqual({
      version: 1,
      appsAuthRelay: true,
      local_policy_override: false,
      search_broker: { route: "gpt-6-luna" },
      routed_agents: { enabled: false, instructions: "", prefer_native_spawn_models: false },
    });
    const observed: boolean[] = [];
    const unsubscribe = store.subscribe(() => observed.push(store.get().appsAuthRelay));
    await store.replace({ version: 1, appsAuthRelay: false });
    expect(observed).toEqual([false]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      appsAuthRelay: false,
      local_policy_override: false,
      search_broker: { route: "gpt-6-luna" },
      routed_agents: { enabled: false, instructions: "", prefer_native_spawn_models: false },
    });
    expect((await openProxyConfigStore(path)).get().appsAuthRelay).toBe(false);
    unsubscribe();
    await store.replace({ version: 1, appsAuthRelay: true });
    expect(observed).toEqual([false]);
  });

  it("rejects malformed settings and defaults an omitted relay setting on", () => {
    expect(parseProxyConfig({ version: 1 })).toEqual({
      version: 1,
      appsAuthRelay: true,
      local_policy_override: false,
      search_broker: { route: "gpt-6-luna" },
      routed_agents: { enabled: false, instructions: "", prefer_native_spawn_models: false },
    });
    expect(() => parseProxyConfig({ version: 1, search_broker: { route: "" } })).toThrow(
      "search_broker.route",
    );
    expect(() => parseProxyConfig({ version: 1, appsAuthRelay: "false" })).toThrow("boolean");
    expect(() => parseProxyConfig({ version: 1, routed_agents: { enabled: "yes" } })).toThrow(
      "routed_agents.enabled",
    );
    expect(() =>
      parseProxyConfig({
        version: 1,
        routed_agents: { enabled: true, prefer_native_spawn_models: "yes" },
      }),
    ).toThrow("routed_agents.prefer_native_spawn_models");
    expect(
      parseProxyConfig({
        version: 1,
        routed_agents: { enabled: true, prefer_native_spawn_models: true },
      }).routed_agents.prefer_native_spawn_models,
    ).toBe(true);
    expect(() => parseProxyConfig({ version: 2 })).toThrow("version 1");
    expect(
      parseProxyConfig({ version: 1, routed_agents: { enabled: true, instructions: "Use GLM" } })
        .routed_agents.instructions,
    ).toBe("Use GLM");
    expect(() =>
      parseProxyConfig({
        version: 1,
        routed_agents: { enabled: true, instructions: "a".repeat(1201) },
      }),
    ).toThrow("routed_agents");
  });
});

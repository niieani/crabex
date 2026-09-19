import { syncPublishedCodexCa, syncCodexCaTransition } from "./tls.ts";
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateWithRollback,
  installArguments,
  launchAgentPlist,
  serviceOrigin,
  updateServiceCodexConfig,
  bootstrapWithRetry,
  LaunchctlError,
} from "./launch-agent.ts";

const previous = {
  release: "/old",
  args: ["proxy"],
  environment: {},
  origin: "http://127.0.0.1:8765",
};
const next = { ...previous, release: "/new" };

describe("LaunchAgent service", () => {
  it("moves default state outside the checkout and preserves explicit paths", () => {
    const args = installArguments(
      ["--config", "custom/config.json", "--listen", "127.0.0.1:9000"],
      "/checkout",
      "/stable/data",
    );
    expect(args.slice(args.lastIndexOf("--config"), args.lastIndexOf("--config") + 2)).toEqual([
      "--config",
      "/checkout/custom/config.json",
    ]);
    expect(args).toContain("/stable/data/model-routes.json");
    expect(args).toContain("/stable/data/captures");
    expect(args).toContain("127.0.0.1:9000");
  });

  it("rejects a non-loopback service listener", () => {
    expect(() => installArguments(["--listen", "0.0.0.0:8765"], "/checkout", "/data")).toThrow(
      "loopback",
    );
  });

  it("escapes plist arguments and environment while keeping runtime paths explicit", () => {
    const plist = launchAgentPlist(
      { ...next, release: "/a & b", environment: { TOKEN: '<secret>&"' } },
      "/root",
      "/logs",
    );
    expect(plist).toContain("/a &amp; b/bun");
    expect(plist).toContain("&lt;secret&gt;&amp;&quot;");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>Umask</key><integer>63</integer>");
  });

  it("persists a new release only after it becomes ready", async () => {
    const calls: string[] = [];
    await activateWithRollback(
      { next, previous },
      {
        activate: async (candidate) => {
          calls.push(`ready:${candidate.release}`);
        },
        persist: async (candidate) => {
          calls.push(`persist:${candidate.release}`);
        },
        remove: async () => {
          calls.push("remove");
        },
      },
    );
    expect(calls).toEqual(["ready:/new", "persist:/new"]);
  });

  it("restores the previous service on failed readiness without another caller action", async () => {
    const calls: string[] = [];
    await expect(
      activateWithRollback(
        { next, previous },
        {
          activate: async (candidate) => {
            calls.push(`activate:${candidate.release}`);
            if (candidate === next) throw new Error("unhealthy");
          },
          persist: async (candidate) => {
            calls.push(`persist:${candidate.release}`);
          },
          remove: async () => {
            calls.push("remove");
          },
        },
      ),
    ).rejects.toThrow("previous service restored");
    expect(calls).toEqual(["activate:/new", "activate:/old", "persist:/old"]);
  });

  it("removes a failed first installation", async () => {
    let removed = false;
    await expect(
      activateWithRollback(
        { next },
        {
          activate: async () => {
            throw new Error("unhealthy");
          },
          persist: async () => {
            throw new Error("must not persist");
          },
          remove: async () => {
            removed = true;
          },
        },
      ),
    ).rejects.toThrow("unhealthy");
    expect(removed).toBe(true);
  });
});

describe("HTTPS service migration", () => {
  it("advertises HTTPS and brackets IPv6 addresses", () => {
    expect(serviceOrigin(["proxy", "--listen", "[::1]:8765", "--tls-dir", "/tls"])).toBe(
      "https://[::1]:8765",
    );
    expect(serviceOrigin(["proxy"])).toBe("http://127.0.0.1:8765");
  });
  it("restores endpoint edits on rollback and preserves concurrent user edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-config-migration-"));
    const path = join(root, "config.toml");
    const update = {
      path,
      before: 'openai_base_url = "http://localhost:8765"\n',
      after: 'openai_base_url = "https://localhost:8765"\n',
    };
    try {
      await writeFile(path, update.before);
      await updateServiceCodexConfig(update, true);
      expect(await readFile(path, "utf8")).toBe(update.after);
      await updateServiceCodexConfig(update, false);
      expect(await readFile(path, "utf8")).toBe(update.before);
      await writeFile(path, "# edited by user\n");
      await expect(updateServiceCodexConfig(update, true)).rejects.toThrow("config changed");
      await updateServiceCodexConfig(update, false);
      expect(await readFile(path, "utf8")).toBe("# edited by user\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("launchd asynchronous teardown", () => {
  it("retries transient bootstrap error 5 until the replacement can register", async () => {
    let calls = 0;
    const waits: number[] = [];
    await bootstrapWithRetry(
      () => {
        if (++calls < 3) throw new LaunchctlError("bootstrap", 5, "Input/output error");
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 250]);
  });
  it("keeps retries bounded and exposes the original diagnostic", async () => {
    let calls = 0;
    await expect(
      bootstrapWithRetry(
        () => {
          calls++;
          throw new LaunchctlError("bootstrap", 5, "Input/output error");
        },
        async () => {},
      ),
    ).rejects.toThrow("Input/output error");
    expect(calls).toBe(21);
  });
  it("does not retry other launchctl errors", async () => {
    let calls = 0;
    await expect(
      bootstrapWithRetry(
        () => {
          calls++;
          throw new LaunchctlError("bootstrap", 122, "permission denied");
        },
        async () => {},
      ),
    ).rejects.toThrow("permission denied");
    expect(calls).toBe(1);
  });
  it("includes the activation error in the rollback log message", async () => {
    await expect(
      activateWithRollback(
        { next, previous },
        {
          activate: async (candidate) => {
            if (candidate === next) throw new Error("bootstrap diagnostic");
          },
          persist: async () => {},
          remove: async () => {},
        },
      ),
    ).rejects.toThrow("previous service restored: bootstrap diagnostic");
  });
});

describe("custom CA publication across service updates", () => {
  const oldCa = { path: "/old-managed.pem", previous: "/original-user.pem" };
  const newCa = { path: "/new-managed.pem", previous: "/original-user.pem" };
  function launchEnvironment(initial?: string) {
    let value = initial;
    return {
      get: (_name: string) => value,
      set: (_name: string, nextValue: string) => {
        value = nextValue;
      },
      unset: (_name: string) => {
        value = undefined;
      },
    };
  }
  it("switches generations after readiness and restores the previous generation on failed persistence", async () => {
    const env = launchEnvironment(oldCa.path);
    const oldService = { ...previous, desktopCodexCa: oldCa };
    const newService = { ...next, desktopCodexCa: newCa };
    await expect(
      activateWithRollback(
        { next: newService, previous: oldService },
        {
          activate: async () => {},
          persist: async (candidate) => {
            syncCodexCaTransition(newCa, oldCa, candidate === newService, env);
            if (candidate === newService) {
              expect(env.get("CODEX_CA_CERTIFICATE")).toBe(newCa.path);
              throw new Error("failed to persist service state");
            }
          },
          remove: async () => {},
        },
      ),
    ).rejects.toThrow("previous service restored");
    expect(env.get("CODEX_CA_CERTIFICATE")).toBe(oldCa.path);
    syncPublishedCodexCa(oldCa, false, env);
    expect(env.get("CODEX_CA_CERTIFICATE")).toBe(oldCa.previous);
  });
  it("keeps the previous bundle when activation failed before publication", () => {
    const env = launchEnvironment(oldCa.path);
    syncCodexCaTransition(newCa, oldCa, false, env);
    expect(env.get("CODEX_CA_CERTIFICATE")).toBe(oldCa.path);
  });
  it("keeps the managed bundle when rolling back a restart or leaf renewal", () => {
    const env = launchEnvironment(oldCa.path);
    syncCodexCaTransition(oldCa, oldCa, false, env);
    expect(env.get("CODEX_CA_CERTIFICATE")).toBe(oldCa.path);
  });
  it("restores original user state on a failed first installation", () => {
    for (const initial of [undefined, "/original-user.pem"]) {
      const env = launchEnvironment(initial);
      const ca = { path: newCa.path, previous: initial };
      syncCodexCaTransition(ca, undefined, true, env);
      syncCodexCaTransition(ca, undefined, false, env);
      expect(env.get("CODEX_CA_CERTIFICATE")).toBe(initial);
    }
  });
  it("preserves concurrent user choices on both forward migration and rollback", () => {
    const env = launchEnvironment("/user-changed.pem");
    expect(() => syncCodexCaTransition(newCa, oldCa, true, env)).toThrow("changed");
    syncCodexCaTransition(newCa, oldCa, false, env);
    expect(env.get("CODEX_CA_CERTIFICATE")).toBe("/user-changed.pem");
  });
});

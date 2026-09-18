import { describe, expect, it } from "vite-plus/test";
import { activateWithRollback, installArguments, launchAgentPlist } from "./launch-agent.ts";

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

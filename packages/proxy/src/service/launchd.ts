import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LEGACY_NAME } from "../config/legacy-migration.ts";
import { lsofListensOn } from "./listeners.ts";
import { checked, runCommand, SupervisorError, type ServiceManager } from "./manager.ts";
import { save, serviceEnvironment, type ServiceState } from "./state.ts";

const LABEL = "com.crabex.proxy";
const LAUNCHCTL = "/bin/launchctl";
const ROOT = join(homedir(), "Library/Application Support/crabex");
const LOGS = join(homedir(), "Library/Logs/crabex");
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid?.()}`;
const TARGET = `${DOMAIN}/${LABEL}`;
const LEGACY_LABEL = `com.${LEGACY_NAME}.proxy`;
const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents", `${LEGACY_LABEL}.plist`);

export function xml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]!;
  });
}

export function launchAgentPlist(state: ServiceState, root = ROOT, logs = LOGS): string {
  const args = [join(state.release, "bun"), join(state.release, "cli.mjs"), ...state.args];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${serviceEnvironment(state)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "proxy.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "proxy-error.log"))}</string>
</dict></plist>\n`;
}

function ctl(...args: string[]): string {
  return checked(runCommand, LAUNCHCTL, args);
}

// bootout can return while launchd is still removing the old job. A valid
// replacement then receives EIO (5); allow teardown to settle before rollback.
export async function bootstrapWithRetry(
  bootstrap: () => void,
  sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      bootstrap();
      return;
    } catch (error) {
      if (
        !(error instanceof SupervisorError) ||
        !error.command.startsWith(`${LAUNCHCTL} bootstrap`) ||
        error.status !== 5 ||
        attempt === 20
      )
        throw error;
      await sleep(250);
    }
  }
}

function loaded(target: string): boolean {
  try {
    ctl("print", target);
    return true;
  } catch {
    return false;
  }
}

function unload(target: string): void {
  if (loaded(target)) ctl("bootout", target);
}

/** A per-user LaunchAgent, started at login and restarted by launchd. */
export function launchdServiceManager(): ServiceManager {
  return {
    kind: "LaunchAgent",
    root: ROOT,
    logs: LOGS,
    supportsHttps: true,
    legacy: {
      label: LEGACY_LABEL,
      root: join(homedir(), "Library/Application Support", LEGACY_NAME),
      logs: join(homedir(), "Library/Logs", LEGACY_NAME),
      async removeUnit() {
        unload(`${DOMAIN}/${LEGACY_LABEL}`);
        await rm(LEGACY_PLIST, { force: true });
      },
    },

    preflight() {},

    registered: () => loaded(TARGET),

    async start(state) {
      unload(TARGET);
      await mkdir(dirname(PLIST), { recursive: true });
      await save(PLIST, launchAgentPlist(state));
      await bootstrapWithRetry(() => ctl("bootstrap", DOMAIN, PLIST));
    },

    async remove() {
      unload(TARGET);
      await rm(PLIST, { force: true });
    },

    mainPid() {
      const pid = /^\s*pid = (\d+)$/m.exec(ctl("print", TARGET))?.[1];
      return pid === undefined ? undefined : Number(pid);
    },

    listensOn: async (pid, port) => lsofListensOn(pid, port),

    status: () =>
      ctl("print", TARGET)
        .split("\n")
        .filter((line) => /^\s*(state|pid|last exit code) =/.test(line))
        .join("\n"),

    recentLogs: () =>
      ["proxy.log", "proxy-error.log"]
        .map((name) => {
          const path = join(LOGS, name);
          const tail = spawnSync("/usr/bin/tail", ["-n", "80", path], { encoding: "utf8" });
          return `\n${path}\n${tail.stdout ?? ""}`;
        })
        .join(""),

    startWorker(command, logPath) {
      // A separate process session with file-backed output survives caller disconnects.
      const output = openSync(logPath, "a", 0o600);
      const child = spawn(command[0]!, command.slice(1), {
        detached: true,
        stdio: ["ignore", output, output],
        cwd: ROOT,
      });
      closeSync(output);
      child.unref();
      let failure: Error | undefined;
      child.on("error", (error) => {
        failure = error;
      });
      return { failure: () => failure, stop: () => child.kill("SIGTERM") };
    },
  };
}

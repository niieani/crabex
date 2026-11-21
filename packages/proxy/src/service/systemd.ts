import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { procListensOn } from "./listeners.ts";
import {
  checked,
  runCommand,
  SupervisorError,
  type Runner,
  type ServiceManager,
} from "./manager.ts";
import { save, serviceEnvironment, type ServiceState } from "./state.ts";

const UNIT = "crabex.service";
const XDG_DIRECTORIES = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const;

export interface SystemdPaths {
  root: string;
  logs: string;
  unit: string;
}

/** Installation paths under the XDG base directories, with their documented defaults. */
export function systemdPaths(
  environment: Record<string, string | undefined>,
  home: string,
): SystemdPaths {
  const base = (name: string, fallback: string) => environment[name] || join(home, fallback);
  return {
    root: join(base("XDG_DATA_HOME", ".local/share"), "crabex"),
    logs: join(base("XDG_STATE_HOME", ".local/state"), "crabex"),
    unit: join(base("XDG_CONFIG_HOME", ".config"), "systemd/user", UNIT),
  };
}

function singleLine(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("A systemd unit value cannot contain a line break");
  return value;
}

/** One quoted unit-file word: systemd unescapes `\\` and `\"`, and expands `%` and `$`. */
export function systemdQuote(value: string): string {
  return `"${singleLine(value).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** A path setting such as `WorkingDirectory=`, which takes the rest of the line unquoted. */
function systemdPath(value: string): string {
  return singleLine(value).replace(/%/g, "%%");
}

/** Like `systemdQuote`, for `Environment=`, which expands specifiers but not variables. */
function environmentQuote(value: string): string {
  return systemdQuote(value).replace(/\$\$/g, "$");
}

export function systemdUnit(state: ServiceState, root: string): string {
  const command = [join(state.release, "bun"), join(state.release, "cli.mjs"), ...state.args];
  const environment = serviceEnvironment(state).map(
    ([key, value]) => `Environment=${environmentQuote(`${key}=${value}`)}`,
  );
  return `[Unit]
Description=Crabex proxy

[Service]
Type=simple
ExecStart=${command.map(systemdQuote).join(" ")}
WorkingDirectory=${systemdPath(root)}
${environment.join("\n")}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}

export interface SystemdOptions {
  paths?: SystemdPaths;
  /** The account whose user manager runs the service. */
  user?: string;
  /** The installer's environment, which decides the paths. */
  environment?: Record<string, string | undefined>;
  run?: Runner;
}

/** A systemd user service, kept running across logout and reboot by lingering. */
export function systemdServiceManager(options: SystemdOptions = {}): ServiceManager {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? systemdPaths(environment, homedir());
  const user = options.user ?? userInfo().username;
  const run = options.run ?? runCommand;
  const systemctl = (...args: string[]) => checked(run, "systemctl", ["--user", ...args]);
  const property = (name: string) =>
    systemctl("show", `--property=${name}`, "--value", UNIT).trim();

  return {
    kind: "systemd user service",
    root: paths.root,
    logs: paths.logs,
    supportsHttps: false,

    preflight() {
      const linger = checked(run, "loginctl", [
        "show-user",
        user,
        "--property=Linger",
        "--value",
      ]).trim();
      if (linger !== "yes")
        throw new Error(
          `Lingering is off for ${user}, so systemd would stop the service at logout and not start it at boot. Enable it with: sudo loginctl enable-linger ${user}`,
        );
    },

    registered: () => property("LoadState") !== "not-found",

    async start(state) {
      await mkdir(dirname(paths.unit), { recursive: true });
      await save(paths.unit, systemdUnit(state, paths.root));
      systemctl("daemon-reload");
      systemctl("enable", UNIT);
      systemctl("restart", UNIT);
    },

    async remove() {
      const exists = await stat(paths.unit).then(
        () => true,
        () => false,
      );
      if (exists) {
        systemctl("disable", UNIT);
        // 5: systemd never loaded the unit, for example after a fatal configuration error.
        const stop = run("systemctl", ["--user", "stop", UNIT]);
        if (stop.status !== 0 && stop.status !== 5)
          throw new SupervisorError(
            `systemctl --user stop ${UNIT}`,
            stop.status,
            stop.stderr.trim(),
          );
      }
      await rm(paths.unit, { force: true });
      systemctl("daemon-reload");
    },

    mainPid() {
      const pid = Number(property("MainPID"));
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },

    listensOn: (pid, port) => procListensOn(pid, port),

    status: () =>
      systemctl("show", "--property=ActiveState,SubState,MainPID,ExecMainStatus", UNIT).trim(),

    recentLogs: () =>
      checked(run, "journalctl", ["--user", "--unit", UNIT, "--lines", "80", "--no-pager"]),

    startWorker(command, logPath) {
      const unit = `crabex-operation-${randomUUID().slice(0, 8)}`;
      let failure: Error | undefined;
      try {
        checked(run, "systemd-run", [
          "--user",
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          `--property=StandardOutput=append:${logPath}`,
          `--property=StandardError=append:${logPath}`,
          `--working-directory=${paths.root}`,
          // The worker resolves the same paths as the installer, not the user manager's.
          ...XDG_DIRECTORIES.flatMap((name) =>
            environment[name] ? [`--setenv=${name}=${environment[name]}`] : [],
          ),
          ...command,
        ]);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      return {
        failure: () => failure,
        stop: () => {
          run("systemctl", ["--user", "stop", unit]);
        },
      };
    },
  };
}

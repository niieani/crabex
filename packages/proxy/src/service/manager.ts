import { spawnSync } from "node:child_process";

import type { ServiceState } from "./state.ts";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a supervisor command synchronously; the seam tests replace. */
export type Runner = (command: string, args: string[]) => CommandResult;

export const runCommand: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** An installation under Crabex's former name, which the next install migrates. */
export interface LegacyInstallation {
  label: string;
  root: string;
  logs: string;
  /** Stops and deletes the legacy supervisor registration. */
  removeUnit(): Promise<void>;
}

export interface WorkerHandle {
  /** The error that prevented the worker from starting, once known. */
  failure(): Error | undefined;
  stop(): void;
}

/**
 * The platform supervisor that keeps the installed proxy running: launchd on macOS,
 * a systemd user manager on Linux. Installation, rollback and readiness are shared.
 */
export interface ServiceManager {
  /** How the supervisor names this kind of service, for messages. */
  readonly kind: string;
  /** Releases, data, launcher and service state. */
  readonly root: string;
  /** Restart worker logs, and proxy output where the supervisor writes files. */
  readonly logs: string;
  /** Whether `--https` can install and trust a local certificate here. */
  readonly supportsHttps: boolean;
  readonly legacy?: LegacyInstallation;
  /** Fails with the remedy when the supervisor cannot keep the service running. */
  preflight(): void;
  /** Whether a service under Crabex's name is registered with the supervisor. */
  registered(): boolean;
  /** Replaces any running service with the candidate and starts it. */
  start(state: ServiceState): Promise<void>;
  /** Stops the service and deletes its registration. */
  remove(): Promise<void>;
  mainPid(): number | undefined;
  listensOn(pid: number, port: number): Promise<boolean>;
  /** Supervisor state lines, without the service environment. */
  status(): string;
  /** The most recent proxy output. */
  recentLogs(): string;
  /** Starts a restart worker that survives the calling session. */
  startWorker(command: string[], logPath: string): WorkerHandle;
}

export class SupervisorError extends Error {
  readonly command: string;
  readonly status: number | null;
  constructor(command: string, status: number | null, detail: string) {
    super(`${command} failed (${status}): ${detail}`);
    this.command = command;
    this.status = status;
  }
}

/** Runs a supervisor command and returns its output, failing with its diagnostic. */
export function checked(run: Runner, command: string, args: string[]): string {
  const result = run(command, args);
  if (result.status !== 0)
    throw new SupervisorError([command, ...args].join(" "), result.status, result.stderr.trim());
  return result.stdout;
}

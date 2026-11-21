import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { CommandResult } from "./manager.ts";
import { systemdPaths, systemdQuote, systemdServiceManager, systemdUnit } from "./systemd.ts";

const state = {
  release: "/data/crabex/releases/r1",
  args: ["proxy", "--listen", "127.0.0.1:8765"],
  environment: { HOME: "/home/u", PATH: "/usr/bin:/bin" },
  origin: "http://127.0.0.1:8765",
};

describe("systemd unit", () => {
  it("quotes arguments so spaces, quotes, backslashes and specifiers survive", () => {
    expect(systemdQuote("plain")).toBe('"plain"');
    expect(systemdQuote('a "b" c\\d')).toBe('"a \\"b\\" c\\\\d"');
    expect(systemdQuote("100%")).toBe('"100%%"');
    expect(systemdQuote("$HOME")).toBe('"$$HOME"');
  });

  it("refuses values a unit file cannot hold", () => {
    expect(() => systemdQuote("two\nlines")).toThrow("line break");
  });

  it("runs the copied runtime with the saved arguments, environment and private umask", () => {
    const unit = systemdUnit(
      {
        ...state,
        environment: { ...state.environment, TOKEN: "s3cr%t" },
        inheritedCaEnvironment: { SSL_CERT_FILE: "/ca.pem" },
      },
      "/data/crabex",
    );
    expect(unit).toContain(
      'ExecStart="/data/crabex/releases/r1/bun" "/data/crabex/releases/r1/cli.mjs" "proxy" "--listen" "127.0.0.1:8765"',
    );
    expect(unit).toContain("WorkingDirectory=/data/crabex\n");
    expect(unit).toContain('Environment="TOKEN=s3cr%%t"');
    expect(unit).toContain('Environment="SSL_CERT_FILE=/ca.pem"');
    expect(unit).toContain('Environment="CRABEX_MANAGED_SERVICE=1"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("writes the working directory unquoted, since systemd takes it verbatim", () => {
    const unit = systemdUnit(state, "/home/a user/100%");
    expect(unit).toContain("WorkingDirectory=/home/a user/100%%\n");
  });

  it("lets selected variables override inherited CA settings", () => {
    const unit = systemdUnit(
      {
        ...state,
        environment: { ...state.environment, SSL_CERT_FILE: "/explicit.pem" },
        inheritedCaEnvironment: { SSL_CERT_FILE: "/previous.pem" },
      },
      "/root",
    );
    expect(unit).toContain('Environment="SSL_CERT_FILE=/explicit.pem"');
    expect(unit).not.toContain("/previous.pem");
  });
});

describe("systemd paths", () => {
  it("follows the XDG base directories, with their documented defaults", () => {
    expect(systemdPaths({}, "/home/u")).toEqual({
      root: "/home/u/.local/share/crabex",
      logs: "/home/u/.local/state/crabex",
      unit: "/home/u/.config/systemd/user/crabex.service",
    });
    expect(
      systemdPaths({ XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s", XDG_CONFIG_HOME: "/c" }, "/home/u"),
    ).toEqual({ root: "/d/crabex", logs: "/s/crabex", unit: "/c/systemd/user/crabex.service" });
  });
});

describe("systemd user service", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(
    answers: Record<string, Partial<CommandResult>> = {},
    environment: Record<string, string> = {},
  ) {
    directory = await mkdtemp(join(tmpdir(), "crabex-systemd-"));
    const calls: string[] = [];
    const manager = systemdServiceManager({
      paths: {
        root: join(directory, "root"),
        logs: join(directory, "logs"),
        unit: join(directory, "user", "crabex.service"),
      },
      user: "u",
      environment,
      run: (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        return { status: 0, stdout: "", stderr: "", ...answers[call] };
      },
    });
    return { manager, calls, unit: join(directory, "user", "crabex.service") };
  }

  it("writes the unit, reloads systemd, enables it and restarts it", async () => {
    const { manager, calls, unit } = await fixture();
    await manager.start(state);
    expect(await readFile(unit, "utf8")).toContain("ExecStart=");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable crabex.service",
      "systemctl --user restart crabex.service",
    ]);
  });

  it("reads the main PID, treating 0 as not running", async () => {
    const running = await fixture({
      "systemctl --user show --property=MainPID --value crabex.service": { stdout: "4242\n" },
    });
    expect(running.manager.mainPid()).toBe(4242);
    const stopped = await fixture({
      "systemctl --user show --property=MainPID --value crabex.service": { stdout: "0\n" },
    });
    expect(stopped.manager.mainPid()).toBeUndefined();
  });

  it("knows whether a crabex unit is registered", async () => {
    const missing = await fixture({
      "systemctl --user show --property=LoadState --value crabex.service": {
        stdout: "not-found\n",
      },
    });
    expect(missing.manager.registered()).toBe(false);
    const loaded = await fixture({
      "systemctl --user show --property=LoadState --value crabex.service": { stdout: "loaded\n" },
    });
    expect(loaded.manager.registered()).toBe(true);
  });

  it("disables, deletes and forgets the unit on removal", async () => {
    const { manager, calls, unit } = await fixture();
    await manager.start(state);
    calls.length = 0;
    await manager.remove();
    expect(calls).toEqual([
      "systemctl --user disable crabex.service",
      "systemctl --user stop crabex.service",
      "systemctl --user daemon-reload",
    ]);
    await expect(readFile(unit)).rejects.toThrow();
  });

  it("removes a unit systemd refused to load", async () => {
    const { manager, unit } = await fixture({
      "systemctl --user stop crabex.service": {
        status: 5,
        stderr: "Failed to stop crabex.service: Unit crabex.service not loaded.",
      },
    });
    await manager.start(state);
    await manager.remove();
    await expect(readFile(unit)).rejects.toThrow();
  });

  it("requires lingering so the service survives logout and starts at boot", async () => {
    const off = await fixture({
      "loginctl show-user u --property=Linger --value": { stdout: "no\n" },
    });
    expect(() => off.manager.preflight()).toThrow("sudo loginctl enable-linger u");
    const on = await fixture({
      "loginctl show-user u --property=Linger --value": { stdout: "yes\n" },
    });
    expect(() => on.manager.preflight()).not.toThrow();
  });

  it("reports the failing systemctl command with its diagnostic", async () => {
    const { manager } = await fixture({
      "systemctl --user restart crabex.service": {
        status: 1,
        stderr: "Job for crabex.service failed",
      },
    });
    await expect(manager.start(state)).rejects.toThrow(
      "systemctl --user restart crabex.service failed (1): Job for crabex.service failed",
    );
  });

  it("gives restart workers the installer's XDG directories, which the user manager lacks", async () => {
    const { manager, calls } = await fixture({}, { XDG_DATA_HOME: "/d", HOME: "/home/u" });
    manager.startWorker(["/r/bun"], "/op.log");
    expect(calls[0]).toContain(" --setenv=XDG_DATA_HOME=/d ");
    expect(calls[0]).not.toContain("HOME=/home/u");
  });

  it("runs restart workers as transient units so they outlive the calling session", async () => {
    const { manager, calls } = await fixture();
    manager.startWorker(["/r/bun", "/r/cli.mjs", "service", "_worker", "/op.json"], "/op.log");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^systemd-run --user --collect --quiet --unit=crabex-operation-\S+ --property=StandardOutput=append:\/op\.log --property=StandardError=append:\/op\.log --working-directory=\S+ \/r\/bun \/r\/cli\.mjs service _worker \/op\.json$/,
    );
  });
});

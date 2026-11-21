import { spawnSync } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

const LISTEN = "0A";

/** Inodes of the sockets listening on `port`, from the kernel's TCP tables. */
async function listeningInodes(proc: string, port: number): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6"]) {
    let text: string;
    try {
      text = await readFile(join(proc, "net", table), "utf8");
    } catch (error) {
      // A kernel without IPv6 has no tcp6 table.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local, , state, , , , , , inode] = fields;
      if (local === undefined || inode === undefined || state !== LISTEN) continue;
      if (Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port) inodes.add(inode);
    }
  }
  return inodes;
}

/** Whether process `pid` holds a socket listening on TCP `port`, read from procfs. */
export async function procListensOn(pid: number, port: number, proc = "/proc"): Promise<boolean> {
  const inodes = await listeningInodes(proc, port);
  if (inodes.size === 0) return false;
  let descriptors: string[];
  try {
    descriptors = await readdir(join(proc, String(pid), "fd"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const descriptor of descriptors) {
    const target = await readlink(join(proc, String(pid), "fd", descriptor)).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode !== undefined && inodes.has(inode)) return true;
  }
  return false;
}

/** Whether process `pid` holds a socket listening on TCP `port`, asked of lsof. */
export function lsofListensOn(pid: number, port: number): boolean {
  const listeners = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  return listeners.stdout?.trim().split(/\s+/).includes(String(pid)) ?? false;
}

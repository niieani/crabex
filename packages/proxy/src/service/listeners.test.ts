import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { procListensOn } from "./listeners.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
// 127.0.0.1:8765 (0x223D) listening, socket inode 1111; an established socket on the same port, inode 2222.
const TCP = `${HEADER}   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:223D 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0000000000000000 20 4 30 10 -1
`;
// [::1]:8766 (0x223E) listening, inode 3333.
const TCP6 = `${HEADER}   0: 00000000000000000000000001000000:223E 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3333 1 0000000000000000 100 0 0 10 0
`;

describe("listener ownership on Linux", () => {
  let proc: string | undefined;
  afterEach(async () => {
    if (proc) await rm(proc, { recursive: true, force: true });
  });

  async function fixture(sockets: Record<number, string[]>) {
    proc = await mkdtemp(join(tmpdir(), "crabex-proc-"));
    await mkdir(join(proc, "net"));
    await writeFile(join(proc, "net", "tcp"), TCP);
    await writeFile(join(proc, "net", "tcp6"), TCP6);
    for (const [pid, links] of Object.entries(sockets)) {
      await mkdir(join(proc, pid, "fd"), { recursive: true });
      for (const [index, target] of links.entries())
        await symlink(target, join(proc, pid, "fd", String(index)));
    }
    return proc;
  }

  it("finds the process holding the listening socket", async () => {
    const root = await fixture({ 10: ["/dev/null", "socket:[1111]"] });
    expect(await procListensOn(10, 8765, root)).toBe(true);
  });

  it("covers IPv6 listeners", async () => {
    const root = await fixture({ 10: ["socket:[3333]"] });
    expect(await procListensOn(10, 8766, root)).toBe(true);
  });

  it("ignores another process's listener and non-listening sockets on the port", async () => {
    const root = await fixture({ 10: ["socket:[2222]"], 11: ["socket:[1111]"] });
    expect(await procListensOn(10, 8765, root)).toBe(false);
  });

  it("treats a process that has exited as not listening", async () => {
    const root = await fixture({});
    expect(await procListensOn(99, 8765, root)).toBe(false);
  });
});

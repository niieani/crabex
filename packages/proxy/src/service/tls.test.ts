import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vite-plus/test";
import WebSocket from "ws";
import {
  configuredCustomCaBundle,
  resolveCustomCaSource,
  prepareCodexCaBundle,
  prepareTls,
  readTls,
  syncPublishedCodexCa,
} from "./tls.ts";
import { startReverseProxy } from "../proxy/server.ts";

// Exercise real certificate generation and both transports without modifying OS trust.
const noTrust = async () => {};

describe("managed local TLS", () => {
  it("stages renewable certificates with private keys and forwards HTTPS and WSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-tls-"));
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return Response.json({ ok: true });
      },
      websocket: {
        message(ws, data) {
          ws.send(data);
        },
      },
    });
    let close: (() => Promise<void>) | undefined;
    try {
      const first = await prepareTls(root, undefined, false, noTrust);
      const ca = new X509Certificate(await readFile(join(root, "ca.pem")));
      const cert = new X509Certificate(await readFile(join(first, "cert.pem")));
      expect(cert.verify(ca.publicKey)).toBe(true);
      expect(cert.ca).toBe(false);
      expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
      expect(cert.checkIP("::1")).toBe("::1");
      expect(cert.checkHost("localhost")).toBe("localhost");
      expect((await stat(join(first, "key.pem"))).mode & 0o077).toBe(0);
      expect((await stat(join(root, "ca-key.pem"))).mode & 0o077).toBe(0);
      expect(await prepareTls(root, first, false, noTrust)).toBe(first);
      const renewed = await prepareTls(root, first, true, noTrust);
      expect(renewed).not.toBe(first);
      expect(await readFile(join(first, "cert.pem"), "utf8")).toBe(cert.toString());
      expect(
        new X509Certificate(await readFile(join(renewed, "cert.pem"))).verify(ca.publicKey),
      ).toBe(true);
      const proxy = await startReverseProxy({
        host: "127.0.0.1",
        port: 0,
        upstreamOrigin: upstream.url.origin,
        appsAuthRelay: false,
        tls: await readTls(renewed),
        captureSink: { async record() {} },
      });
      close = () => proxy.close();
      expect(proxy.origin.startsWith("https://")).toBe(true);
      const caPem = await readFile(join(root, "ca.pem"), "utf8");
      const response = await fetch(`${proxy.origin}/backend-api/accounts/check`, {
        tls: { ca: caPem },
      });
      expect(await response.json()).toEqual({ ok: true });
      await expect(fetch(proxy.origin)).rejects.toThrow();
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `${proxy.origin.replace("https:", "wss:")}/backend-api/codex/responses`,
          { ca: caPem, tls: { ca: caPem } } as import("ws").ClientOptions & { tls: { ca: string } },
        );
        ws.on("error", reject);
        ws.on("open", () => ws.send(JSON.stringify({ type: "probe" })));
        ws.on("message", (message) => {
          try {
            expect(
              JSON.parse(
                (Array.isArray(message)
                  ? Buffer.concat(message)
                  : Buffer.from(message as ArrayBuffer)
                ).toString(),
              ),
            ).toEqual({ type: "probe" });
            ws.close();
            resolve();
          } catch (error) {
            ws.terminate();
            reject(error);
          }
        });
      });
    } finally {
      await close?.();
      await upstream.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to manage a CA whose ownership fingerprint changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-tls-owner-"));
    try {
      const directory = await prepareTls(root, undefined, false, noTrust);
      await writeFile(join(root, "owner.json"), JSON.stringify({ fingerprint: "different" }));
      await expect(prepareTls(root, directory, true, noTrust)).rejects.toThrow(
        "ownership fingerprint mismatch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched private keys before starting a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-tls-key-"));
    try {
      const directory = await prepareTls(root, undefined, false, noTrust);
      await writeFile(join(directory, "key.pem"), await readFile(join(root, "ca-key.pem")));
      await expect(readTls(directory)).rejects.toThrow("do not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extends a configured custom CA bundle only when one is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-tls-custom-ca-"));
    try {
      await prepareTls(root, undefined, false, noTrust);
      expect(configuredCustomCaBundle({})).toBeUndefined();
      expect(await prepareCodexCaBundle(root)).toBeUndefined();

      const custom = join(root, "enterprise-roots.pem");
      await writeFile(custom, await readFile(join(root, "ca.pem"), "utf8"));
      expect(configuredCustomCaBundle({ SSL_CERT_FILE: custom })).toBe(custom);
      const combined = await prepareCodexCaBundle(root, custom);
      expect(combined).toContain(join(root, "codex-ca-bundles"));
      expect((await readFile(combined!, "utf8")).match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a new bundle without modifying the active roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "act-tls-bundle-update-"));
    try {
      await prepareTls(root, undefined, false, noTrust);
      const custom = join(root, "external.pem");
      const ca = await readFile(join(root, "ca.pem"), "utf8");
      await writeFile(custom, ca);
      const active = (await prepareCodexCaBundle(root, custom))!;
      const oldContents = await readFile(active, "utf8");
      await writeFile(custom, `# rotated enterprise roots\n${ca}`);
      const candidate = (await prepareCodexCaBundle(root, custom))!;
      expect(candidate).not.toBe(active);
      expect(await readFile(active, "utf8")).toBe(oldContents);
      expect(await readFile(candidate, "utf8")).toContain("# rotated enterprise roots");
      expect((await stat(candidate)).mode & 0o077).toBe(0);
      await expect(prepareCodexCaBundle(root, join(root, "missing.pem"))).rejects.toThrow();
      expect(await readFile(active, "utf8")).toBe(oldContents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores only the launch environment value it published", () => {
    const values = new Map<string, string>([["CODEX_CA_CERTIFICATE", "/prior.pem"]]);
    const environment = {
      get: (name: string) => values.get(name),
      set: (name: string, value: string) => values.set(name, value),
      unset: (name: string) => values.delete(name),
    };
    const managed = { path: "/managed.pem", previous: "/prior.pem" };
    syncPublishedCodexCa(managed, true, environment);
    expect(values.get("CODEX_CA_CERTIFICATE")).toBe("/managed.pem");
    syncPublishedCodexCa(managed, false, environment);
    expect(values.get("CODEX_CA_CERTIFICATE")).toBe("/prior.pem");

    values.set("CODEX_CA_CERTIFICATE", "/user-choice.pem");
    syncPublishedCodexCa(managed, false, environment);
    expect(values.get("CODEX_CA_CERTIFICATE")).toBe("/user-choice.pem");
  });
});

describe("original custom CA source", () => {
  const root = "/installation/tls";
  const managed = { path: `${root}/codex-ca-bundles/current.pem`, source: "/enterprise/roots.pem" };
  it("resolves an inherited managed override back to its original source", () => {
    expect(
      resolveCustomCaSource(
        root,
        [{}, { CODEX_CA_CERTIFICATE: managed.path, SSL_CERT_FILE: "/enterprise/roots.pem" }],
        managed,
      ),
    ).toBe(managed.source);
    expect(
      resolveCustomCaSource(
        root,
        [{ CODEX_CA_CERTIFICATE: `${root}/codex-ca-bundles/older.pem` }],
        managed,
      ),
    ).toBe(managed.source);
  });
  it("uses the saved source when the installer no longer inherits CA variables", () => {
    expect(resolveCustomCaSource(root, [{}], managed)).toBe(managed.source);
  });
  it("honors an explicitly configured external source", () => {
    expect(
      resolveCustomCaSource(
        root,
        [{ SSL_CERT_FILE: "/new/roots.pem" }, { CODEX_CA_CERTIFICATE: managed.path }],
        managed,
      ),
    ).toBe("/new/roots.pem");
    expect(
      resolveCustomCaSource(
        root,
        [{ CODEX_CA_CERTIFICATE: "/custom.pem", SSL_CERT_FILE: "/fallback.pem" }],
        managed,
      ),
    ).toBe("/custom.pem");
  });
  it("migrates legacy service state using the external SSL_CERT_FILE", () => {
    expect(
      resolveCustomCaSource(
        root,
        [
          {
            CODEX_CA_CERTIFICATE: `${root}/codex-ca-bundle.pem`,
            SSL_CERT_FILE: "/enterprise/roots.pem",
          },
        ],
        { path: `${root}/codex-ca-bundle.pem` },
      ),
    ).toBe("/enterprise/roots.pem");
  });
  it("refuses to consume managed output when the original source is unknown", () => {
    expect(() =>
      resolveCustomCaSource(root, [{ CODEX_CA_CERTIFICATE: managed.path }], { path: managed.path }),
    ).toThrow("original custom CA");
    expect(resolveCustomCaSource(root, [{}])).toBeUndefined();
    expect(
      configuredCustomCaBundle({ CODEX_CA_CERTIFICATE: "", SSL_CERT_FILE: "/fallback.pem" }),
    ).toBe("/fallback.pem");
  });
  it("refreshes changed source contents without accumulating the managed certificate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-ca-source-"));
    try {
      await prepareTls(directory, undefined, false, noTrust);
      const source = join(directory, "external.pem");
      const ca = await readFile(join(directory, "ca.pem"), "utf8");
      await writeFile(source, ca);
      const first = (await prepareCodexCaBundle(directory, source))!;
      await writeFile(source, `# rotated roots\n${ca}`);
      const resolved = resolveCustomCaSource(directory, [{ CODEX_CA_CERTIFICATE: first }], {
        path: first,
        source,
      });
      const second = (await prepareCodexCaBundle(directory, resolved))!;
      const text = await readFile(second, "utf8");
      expect(text).toContain("# rotated roots");
      expect(text.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

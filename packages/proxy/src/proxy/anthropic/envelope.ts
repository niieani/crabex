import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Json = Record<string, unknown>;
export function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export class AnthropicRequestError extends Error {
  readonly status = 400;
}
const PREFIX = "acta1:";
const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;

/** Keep beside the route file and back it up with Codex sessions. Survives token rotation. */
export async function openAnthropicKey(path: string): Promise<Uint8Array> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!record(error) || error.code !== "EEXIST") throw error;
  }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error("Invalid Anthropic replay key (expected 32 bytes)");
  return key;
}

/** Inspired by opencodex's replay envelope; encrypted/authenticated here rather than base64 only. */
export class AnthropicEnvelope {
  private readonly key: Uint8Array;
  private readonly scope: string;
  constructor(key: Uint8Array, scope: string) {
    this.key = key;
    this.scope = scope;
  }

  seal(value: Json): string {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_ENVELOPE_BYTES)
      throw new AnthropicRequestError("Anthropic replay state exceeds 32 MiB");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(this.scope));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  open(value: unknown): Json {
    if (typeof value !== "string" || !value.startsWith(PREFIX)) {
      throw new AnthropicRequestError(
        "Cannot replay another provider's opaque reasoning/compaction on this Anthropic route. Start a fresh task or use its original route.",
      );
    }
    if (value.length > MAX_ENVELOPE_BYTES * 1.4)
      throw new AnthropicRequestError("Anthropic replay envelope too large");
    try {
      const bytes = Buffer.from(value.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(this.scope));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const decoded: unknown = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
      if (!record(decoded)) throw new Error("Invalid state");
      return decoded;
    } catch {
      throw new AnthropicRequestError(
        "Cannot decrypt Anthropic replay state: use the original route and replay key.",
      );
    }
  }
}

export function text(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new AnthropicRequestError("Expected a string field");
  return value;
}

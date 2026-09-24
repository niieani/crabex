import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface CacheOptions<T> {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  isValue(value: unknown): value is T;
  now?: () => number;
  warn?: (message: string) => void;
  debounceMs?: number;
}

interface DiskEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
}

const VERSION = 1;
const EMPTY_BYTES = Buffer.byteLength('{"version":1,"entries":[]}\n');
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Bounded, expiring LRU with optional debounced atomic disk persistence. */
export class PersistentLruCache<T> {
  readonly #entries = new Map<string, { entry: DiskEntry<T>; bytes: number }>();
  readonly #options: Required<
    Pick<CacheOptions<T>, "maxEntries" | "maxBytes" | "ttlMs" | "isValue">
  > & {
    now: () => number;
    warn: (message: string) => void;
    debounceMs: number;
  };
  readonly #filePath?: string;
  #entryBytes = 0;
  #dirty = false;
  #timer?: ReturnType<typeof setTimeout>;
  #flushTail = Promise.resolve();

  constructor(options: CacheOptions<T>, filePath?: string) {
    if (
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes <= EMPTY_BYTES ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 1
    )
      throw new Error("Invalid persistent cache limits");
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      warn: options.warn ?? ((message) => console.warn(message)),
      debounceMs: options.debounceMs ?? 100,
    };
    this.#filePath = filePath;
  }

  static async open<T>(filePath: string, options: CacheOptions<T>): Promise<PersistentLruCache<T>> {
    const cache = new PersistentLruCache(options, filePath);
    await cache.#load();
    return cache;
  }

  get(key: string): T | undefined {
    const digest = hashKey(key);
    const found = this.#entries.get(digest);
    if (found === undefined) return undefined;
    if (found.entry.expiresAt <= this.#options.now()) {
      this.#remove(digest);
      this.#schedule();
      return undefined;
    }
    this.#entries.delete(digest);
    this.#entries.set(digest, found);
    this.#schedule();
    return structuredClone(found.entry.value);
  }

  set(key: string, value: T): void {
    if (!this.#options.isValue(value)) throw new Error("Invalid persistent cache value");
    const digest = hashKey(key);
    const entry: DiskEntry<T> = {
      key: digest,
      value: structuredClone(value),
      expiresAt: this.#options.now() + this.#options.ttlMs,
    };
    if (EMPTY_BYTES + Buffer.byteLength(JSON.stringify(entry)) > this.#options.maxBytes) {
      if (this.#remove(digest)) this.#schedule();
      this.#options.warn(
        "Persistent session cache entry exceeded its size limit; state was discarded",
      );
      return;
    }
    this.#remove(digest);
    this.#insert(entry);
    this.#prune();
    this.#schedule();
  }

  delete(key: string): void {
    if (this.#remove(hashKey(key))) this.#schedule();
  }

  async flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flushTail = this.#flushTail.then(async () => {
      while (this.#dirty && this.#filePath !== undefined) {
        this.#dirty = false;
        const body =
          JSON.stringify({
            version: VERSION,
            entries: [...this.#entries.values()].map(({ entry }) => entry),
          }) + "\n";
        try {
          await atomicWrite(this.#filePath, body);
        } catch (error) {
          this.#dirty = true;
          this.#options.warn(`Could not persist session cache: ${errorMessage(error)}`);
          break;
        }
      }
    });
    await this.#flushTail;
  }

  #insert(entry: DiskEntry<T>): void {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    this.#entries.set(entry.key, { entry, bytes });
    this.#entryBytes += bytes;
  }

  #remove(key: string): boolean {
    const found = this.#entries.get(key);
    if (found === undefined) return false;
    this.#entries.delete(key);
    this.#entryBytes -= found.bytes;
    return true;
  }

  #prune(): void {
    const now = this.#options.now();
    for (const [key, value] of this.#entries) {
      if (value.entry.expiresAt <= now) this.#remove(key);
    }
    while (
      this.#entries.size > this.#options.maxEntries ||
      EMPTY_BYTES + this.#entryBytes + Math.max(0, this.#entries.size - 1) > this.#options.maxBytes
    ) {
      this.#remove(this.#entries.keys().next().value!);
    }
  }

  #schedule(): void {
    if (this.#filePath === undefined) return;
    this.#dirty = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.debounceMs);
    this.#timer.unref?.();
  }

  async #load(): Promise<void> {
    if (this.#filePath === undefined) return;
    try {
      if ((await stat(this.#filePath)).size > this.#options.maxBytes)
        throw new Error("file exceeds the cache size limit");
      const value: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!record(value) || value.version !== VERSION || !Array.isArray(value.entries))
        throw new Error("unsupported cache version or shape");
      const seen = new Set<string>();
      const storedCount = value.entries.length;
      for (const item of value.entries) {
        if (
          !record(item) ||
          typeof item.key !== "string" ||
          !KEY_PATTERN.test(item.key) ||
          seen.has(item.key) ||
          typeof item.expiresAt !== "number" ||
          !Number.isSafeInteger(item.expiresAt) ||
          !this.#options.isValue(item.value)
        )
          throw new Error("invalid cache entry");
        seen.add(item.key);
        if (item.expiresAt > this.#options.now()) {
          this.#insert({
            key: item.key,
            value: structuredClone(item.value),
            expiresAt: item.expiresAt,
          });
        }
      }
      this.#prune();
      if (this.#entries.size !== storedCount) this.#schedule();
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return;
      this.#entries.clear();
      this.#entryBytes = 0;
      this.#options.warn(`Ignoring session cache ${this.#filePath}: ${errorMessage(error)}`);
    }
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function atomicWrite(filePath: string, body: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

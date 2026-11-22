import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_NAME_LENGTH = 64;

export interface ClientKeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface IssuedClientKey extends ClientKeySummary {
  /** Returned only by `issue`; only its hash is kept. */
  secret: string;
}

export interface ClientKeyStore {
  list(): ClientKeySummary[];
  issue(name: string): Promise<IssuedClientKey>;
  revoke(id: string): Promise<void>;
  verify(secret: string): ClientKeySummary | undefined;
  /** Called with a key's id once it is revoked; returns an unsubscribe function. */
  onRevoke(listener: (id: string) => void): () => void;
}

interface StoredKey extends ClientKeySummary {
  hash: string;
}

export async function openClientKeyStore(path: string): Promise<ClientKeyStore> {
  let keys = await readKeys(path);
  let writes: Promise<void> = Promise.resolve();
  const revocationListeners = new Set<(id: string) => void>();

  /** Serialized so a slower write never lands after a newer one. */
  const persist = (next: StoredKey[]) => {
    const write = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, keys: next }, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    });
    writes = write.catch(() => {});
    return write;
  };

  return {
    list: () => keys.map(summary),
    async issue(rawName) {
      const name = rawName.trim();
      if (name === "" || name.length > MAX_NAME_LENGTH)
        throw new Error(`Client Key name must be 1-${MAX_NAME_LENGTH} characters`);
      if (keys.some((key) => key.name === name))
        throw new Error(`a Client Key named "${name}" already exists`);
      const secret = `crabex_${randomBytes(32).toString("base64url")}`;
      const key: StoredKey = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        hash: hashSecret(secret),
      };
      keys = [...keys, key];
      try {
        await persist(keys);
      } catch (error) {
        keys = keys.filter((candidate) => candidate.id !== key.id);
        throw error;
      }
      return { ...summary(key), secret };
    },
    async revoke(id) {
      if (!keys.some((key) => key.id === id)) throw new Error(`unknown Client Key: ${id}`);
      // Stop accepting it before the write, so a slow disk never extends its life.
      keys = keys.filter((key) => key.id !== id);
      for (const listener of revocationListeners) listener(id);
      await persist(keys);
    },
    onRevoke(listener) {
      revocationListeners.add(listener);
      return () => revocationListeners.delete(listener);
    },
    verify(secret) {
      if (secret === "") return undefined;
      const hash = hashSecret(secret);
      const key = keys.find((candidate) => candidate.hash === hash);
      if (key === undefined) return undefined;
      // Kept in memory and written with the next issue or revoke, so requests never touch the disk.
      key.lastUsedAt = new Date().toISOString();
      return summary(key);
    },
  };
}

function summary({ hash: _hash, ...key }: StoredKey): ClientKeySummary {
  return { ...key };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function readKeys(path: string): Promise<StoredKey[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text) as { version?: unknown; keys?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.keys) || !parsed.keys.every(isStoredKey))
    throw new Error(`invalid Client Key file: ${path}`);
  return parsed.keys;
}

function isStoredKey(value: unknown): value is StoredKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.id === "string" &&
    typeof key.name === "string" &&
    typeof key.createdAt === "string" &&
    typeof key.hash === "string"
  );
}

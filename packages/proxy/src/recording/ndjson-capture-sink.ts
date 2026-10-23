import { randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { CaptureEvent, CaptureSink } from "./capture.ts";
import { pruneCaptures, type CaptureRetentionLimits } from "./capture-pruning.ts";

/** A capture file is closed and a new one started past this size. */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface CaptureWriter {
  write(value: string): Promise<void>;
  close(): Promise<void>;
}

export class NdjsonCaptureSink implements CaptureSink {
  #failure: unknown;
  #tail = Promise.resolve();
  readonly #writer: CaptureWriter;

  constructor(writer: CaptureWriter) {
    this.#writer = writer;
  }

  record(event: CaptureEvent): Promise<void> {
    const operation = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      try {
        await this.#writer.write(`${JSON.stringify(event)}\n`);
      } catch (error) {
        this.#failure = error;
        throw error;
      }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await this.#tail;
    await this.#writer.close();
  }
}

export interface RotatingCaptureOptions {
  retention: CaptureRetentionLimits;
  maxFileBytes?: number;
  now?: () => Date;
}

/**
 * Writes captures to a new file each UTC day or past `maxFileBytes`, and
 * prunes old files on startup and after every rotation.
 */
export async function openRotatingCaptureSink(
  directory: string,
  options: RotatingCaptureOptions,
): Promise<NdjsonCaptureSink> {
  const writer = new RotatingCaptureWriter(directory, options);
  await writer.open();
  return new NdjsonCaptureSink(writer);
}

class RotatingCaptureWriter implements CaptureWriter {
  readonly #directory: string;
  readonly #options: RotatingCaptureOptions;
  readonly #now: () => Date;
  #handle: FileHandle | undefined;
  #name = "";
  #day = "";
  #bytes = 0;

  constructor(directory: string, options: RotatingCaptureOptions) {
    this.#directory = directory;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async open(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const now = this.#now();
    this.#name = `${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.ndjson`;
    this.#day = now.toISOString().slice(0, 10);
    this.#bytes = 0;
    this.#handle = await open(join(this.#directory, this.#name), "wx", 0o600);
    await this.#prune();
  }

  async write(value: string): Promise<void> {
    const due =
      this.#bytes >= (this.#options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) ||
      this.#now().toISOString().slice(0, 10) !== this.#day;
    if (due && this.#bytes > 0) {
      await this.#handle?.close();
      await this.open();
    }
    await this.#handle!.writeFile(value);
    this.#bytes += Buffer.byteLength(value);
  }

  async close(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;
  }

  async #prune(): Promise<void> {
    try {
      await pruneCaptures(this.#directory, this.#options.retention, {
        keep: this.#name,
        now: this.#now().getTime(),
      });
    } catch (error) {
      // Retention is housekeeping; failing to delete must not stop capturing.
      console.error(
        `Could not prune captures: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

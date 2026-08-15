import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type { CaptureEvent, CaptureSink } from "./capture.ts";

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

export async function openNdjsonCaptureSink(filePath: string): Promise<NdjsonCaptureSink> {
  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(filePath, "wx", 0o600);
  return new NdjsonCaptureSink(new FileCaptureWriter(handle));
}

class FileCaptureWriter implements CaptureWriter {
  readonly #handle: FileHandle;

  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  async write(value: string): Promise<void> {
    await this.#handle.writeFile(value);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

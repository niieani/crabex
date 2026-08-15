import type { JsonPathSegment } from "../../lib/types.ts";

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface JsonStringSelection {
  find: string;
  jsonPath: JsonPathSegment[];
}

interface StringLeaf {
  path: JsonPathSegment[];
  contentStart: number;
  contentEnd: number;
}

export function resolveJsonStringSelection(
  displayedJson: string,
  actualJson: string,
  range: TextRange,
): JsonStringSelection | undefined {
  try {
    const start = positionOffset(displayedJson, range.start);
    const end = positionOffset(displayedJson, range.end);
    if (start >= end) return undefined;
    const leaf = new JsonStringLeafParser(displayedJson)
      .parse()
      .find((candidate) => start >= candidate.contentStart && end <= candidate.contentEnd);
    if (leaf === undefined) return undefined;
    const find = decodeStringFragment(displayedJson.slice(start, end));
    if (find === "") return undefined;
    const actualValue = valueAtPath(JSON.parse(actualJson), leaf.path);
    if (typeof actualValue !== "string" || !actualValue.includes(find)) return undefined;
    return { find, jsonPath: leaf.path };
  } catch {
    return undefined;
  }
}

function positionOffset(source: string, position: TextPosition): number {
  if (position.line < 0 || position.character < 0) throw new Error("invalid text position");
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) throw new Error("text position is outside the document");
    offset = newline + 1;
  }
  const lineEnd = source.indexOf("\n", offset);
  const end = lineEnd === -1 ? source.length : lineEnd;
  if (offset + position.character > end) throw new Error("text position is outside the line");
  return offset + position.character;
}

function decodeStringFragment(source: string): string {
  return JSON.parse(`"${source}"`) as string;
}

function valueAtPath(root: unknown, path: JsonPathSegment[]): unknown {
  let value = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(value) || segment < 0 || segment >= value.length) return undefined;
      value = value[segment];
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

class JsonStringLeafParser {
  readonly #source: string;
  readonly #leaves: StringLeaf[] = [];
  #cursor = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): StringLeaf[] {
    this.#value([]);
    this.#space();
    if (this.#cursor !== this.#source.length) throw new Error("unexpected JSON suffix");
    return this.#leaves;
  }

  #value(path: JsonPathSegment[]): void {
    this.#space();
    const token = this.#source[this.#cursor];
    if (token === "{") this.#object(path);
    else if (token === "[") this.#array(path);
    else if (token === '"') {
      const string = this.#string();
      this.#leaves.push({
        path,
        contentStart: string.contentStart,
        contentEnd: string.contentEnd,
      });
    } else this.#primitive();
  }

  #object(path: JsonPathSegment[]): void {
    this.#expect("{");
    this.#space();
    if (this.#take("}")) return;
    while (true) {
      this.#space();
      const key = this.#string().value;
      this.#space();
      this.#expect(":");
      this.#value([...path, key]);
      this.#space();
      if (this.#take("}")) return;
      this.#expect(",");
    }
  }

  #array(path: JsonPathSegment[]): void {
    this.#expect("[");
    this.#space();
    if (this.#take("]")) return;
    let index = 0;
    while (true) {
      this.#value([...path, index]);
      index += 1;
      this.#space();
      if (this.#take("]")) return;
      this.#expect(",");
    }
  }

  #string(): { value: string; contentStart: number; contentEnd: number } {
    const start = this.#cursor;
    this.#expect('"');
    const contentStart = this.#cursor;
    while (this.#cursor < this.#source.length) {
      const token = this.#source[this.#cursor];
      if (token === "\\") {
        this.#cursor += 2;
        continue;
      }
      if (token === '"') {
        const contentEnd = this.#cursor;
        this.#cursor += 1;
        return {
          value: JSON.parse(this.#source.slice(start, this.#cursor)) as string,
          contentStart,
          contentEnd,
        };
      }
      this.#cursor += 1;
    }
    throw new Error("unterminated JSON string");
  }

  #primitive(): void {
    const start = this.#cursor;
    while (this.#cursor < this.#source.length && !/[,\]}\s]/.test(this.#source[this.#cursor]!)) {
      this.#cursor += 1;
    }
    if (start === this.#cursor) throw new Error("expected JSON value");
  }

  #space(): void {
    while (/\s/.test(this.#source[this.#cursor] ?? "")) this.#cursor += 1;
  }

  #take(token: string): boolean {
    if (this.#source[this.#cursor] !== token) return false;
    this.#cursor += 1;
    return true;
  }

  #expect(token: string): void {
    if (!this.#take(token)) throw new Error(`expected ${token}`);
  }
}

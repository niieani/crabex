/** Serialize JSON-shaped configuration as TOML, rejecting values TOML cannot express. */
export function serializeToml(object: Record<string, unknown>): string {
  const lines: string[] = [];
  const quote = (value: string) => JSON.stringify(value).replace(/\x7f/g, "\\u007f");
  const key = (value: string) => (/^[A-Za-z0-9_-]+$/.test(value) ? value : quote(value));
  function scalar(value: unknown): string {
    if (typeof value === "string") return quote(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return "[" + value.map(scalar).join(", ") + "]";
    if (isRecord(value))
      return (
        "{ " +
        Object.entries(value)
          .map(([name, item]) => key(name) + " = " + scalar(item))
          .join(", ") +
        " }"
      );
    throw new Error("unsupported TOML value");
  }
  function table(value: Record<string, unknown>, path: string[]) {
    if (path.length) lines.push("", "[" + path.map(key).join(".") + "]");
    for (const [name, item] of Object.entries(value)) {
      if (!isRecord(item)) lines.push(key(name) + " = " + scalar(item));
    }
    for (const [name, item] of Object.entries(value)) {
      if (isRecord(item)) table(item, [...path, name]);
    }
  }
  table(object, []);
  return lines.join("\n").trimStart() + "\n";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

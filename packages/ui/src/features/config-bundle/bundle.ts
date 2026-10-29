import { tomlError } from "./TomlEditor.tsx";

export const sections = ["config_toml", "requirements_toml"] as const;
export type Section = (typeof sections)[number];
export interface Fragment {
  id: string;
  name: string;
  contents: string;
  [key: string]: unknown;
}
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function fragments(bundle: unknown, section: Section): Fragment[] {
  const value = record(record(bundle)[section]).enterprise_managed;
  return Array.isArray(value) ? (value as Fragment[]) : [];
}
export function validation(bundle: unknown): string | undefined {
  if (bundle !== null && (typeof bundle !== "object" || Array.isArray(bundle)))
    return "Bundle must be a JSON object.";
  for (const section of sections) {
    const value = record(bundle)[section];
    if (value != null && (typeof value !== "object" || Array.isArray(value)))
      return section + " must be an object or null.";
    const list = record(value).enterprise_managed;
    if (list != null && !Array.isArray(list)) return section + " fragments must be an array.";
    const ids = new Set<string>();
    for (const fragment of fragments(bundle, section)) {
      if (
        !fragment ||
        typeof fragment.id !== "string" ||
        !fragment.id.trim() ||
        ids.has(fragment.id)
      )
        return section + ": fragment ids must be non-empty and unique.";
      ids.add(fragment.id);
      if (typeof fragment.name !== "string" || typeof fragment.contents !== "string")
        return section + ": fragment name and contents must be strings.";
      const error = tomlError(fragment.contents);
      if (error) return section + ' fragment "' + fragment.id + '": ' + error;
    }
  }
}

export const BUNDLE_SECTIONS = ["config_toml", "requirements_toml"] as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Fragments arrive highest precedence first. Never mutate either input. */
export function mergeConfigBundles(upstream: unknown, local: unknown): unknown {
  const base = record(upstream);
  const additions = record(local);
  const merged = structuredClone(base);
  for (const key of BUNDLE_SECTIONS) {
    const localSection = record(additions[key]);
    const localFragments = Array.isArray(localSection.enterprise_managed)
      ? localSection.enterprise_managed
      : [];
    if (localFragments.length === 0) continue;
    const section = record(base[key]);
    const upstreamFragments = Array.isArray(section.enterprise_managed)
      ? section.enterprise_managed
      : [];
    const ids = new Set(localFragments.map((fragment) => record(fragment).id));
    merged[key] = structuredClone({
      ...section,
      enterprise_managed: [
        ...localFragments,
        ...upstreamFragments.filter((fragment) => !ids.has(record(fragment).id)),
      ],
    });
  }
  return merged;
}

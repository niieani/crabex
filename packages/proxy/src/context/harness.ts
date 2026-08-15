export type HarnessKind = "desktop" | "tui" | "unknown" | "conflicted";

export interface HarnessIdentity {
  kind: HarnessKind;
  version?: string;
  build?: string;
}

export function classifyHarness(headers: Headers): HarnessIdentity {
  const originatorKind = kindFromOriginator(headers.get("originator"));
  const userAgent = headers.get("user-agent") ?? "";
  const userAgentKind = kindFromUserAgent(userAgent);

  if (
    originatorKind !== "unknown" &&
    userAgentKind !== "unknown" &&
    originatorKind !== userAgentKind
  ) {
    return { kind: "conflicted" };
  }

  const kind = originatorKind === "unknown" ? userAgentKind : originatorKind;
  if (kind === "desktop") {
    const version = userAgent.match(/^Codex Desktop\/([^\s]+)/)?.[1];
    const build = userAgent.match(/\(Codex Desktop;\s*([^\s)]+)\)/)?.[1];
    return compact({ kind, version, build });
  }
  if (kind === "tui") {
    const version = userAgent.match(/^codex-tui\/([^\s]+)/i)?.[1];
    return compact({ kind, version });
  }
  return { kind };
}

function kindFromOriginator(value: string | null): "desktop" | "tui" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "codex desktop") return "desktop";
  if (normalized === "codex-tui") return "tui";
  return "unknown";
}

function kindFromUserAgent(value: string): "desktop" | "tui" | "unknown" {
  if (/^Codex Desktop\//i.test(value)) return "desktop";
  if (/^codex-tui\//i.test(value)) return "tui";
  return "unknown";
}

function compact(identity: HarnessIdentity): HarnessIdentity {
  return Object.fromEntries(
    Object.entries(identity).filter(([, value]) => value !== undefined),
  ) as unknown as HarnessIdentity;
}

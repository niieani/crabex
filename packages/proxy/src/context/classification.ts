export interface ContentClassification {
  id: string;
  label: string;
}

export interface ContentSection extends ContentClassification {
  kind: "heading" | "skill" | "tool" | "mcp";
  start: number;
  end: number;
  text: string;
  children: ContentSection[];
}

const MESSAGE_CLASSIFICATIONS: Array<{
  role: string;
  prefix: string;
  id: string;
  label: string;
}> = [
  {
    role: "developer",
    prefix: "You are Codex, ",
    id: "segment:codex_base",
    label: "Codex base instructions",
  },
  {
    role: "developer",
    prefix: "<skills_instructions>",
    id: "segment:skills",
    label: "Skills instructions",
  },
  {
    role: "developer",
    prefix: "<permissions instructions>",
    id: "segment:permissions",
    label: "Permissions",
  },
  {
    role: "developer",
    prefix: "<apps_instructions>",
    id: "segment:apps",
    label: "Apps instructions",
  },
  {
    role: "developer",
    prefix: "<plugins_instructions>",
    id: "segment:plugins",
    label: "Plugins instructions",
  },
  {
    role: "user",
    prefix: "<recommended_plugins>",
    id: "segment:recommended_plugins",
    label: "Recommended plugins",
  },
  {
    role: "user",
    prefix: "# AGENTS.md instructions for ",
    id: "segment:project_instructions",
    label: "Project instructions",
  },
  {
    role: "user",
    prefix: "<environment_context>",
    id: "segment:environment",
    label: "Environment context",
  },
];

export function classifyMessage(role: string | undefined, text: string): ContentClassification | undefined {
  const found = MESSAGE_CLASSIFICATIONS.find(
    (classification) => classification.role === role && text.startsWith(classification.prefix),
  );
  return found === undefined ? undefined : { id: found.id, label: found.label };
}

export function markdownSections(text: string, parentId: string): ContentSection[] {
  const lines = sourceLines(text);
  const headings = lines.flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.value);
    if (match === null) return [];
    const rawLabel = (match[2] ?? "").trim();
    const label = stripHeadingMarkup(rawLabel);
    return [{ line, level: match[1]?.length ?? 1, label, toolName: toolHeadingName(rawLabel) }];
  });
  const roots: ContentSection[] = [];
  const stack: Array<{ level: number; section: ContentSection }> = [];

  for (const [index, heading] of headings.entries()) {
    while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    const parent = stack.at(-1)?.section;
    const end = nextBoundary(headings, index, heading.level, text.length);
    const toolName = heading.toolName;
    const id =
      toolName === undefined
        ? `${parent?.id ?? `section:${parentId}`}/${slug(heading.label)}`
        : `tool:${toolName}`;
    const section: ContentSection = {
      id,
      label: toolName ?? heading.label,
      kind: toolName?.startsWith("mcp__") ? "mcp" : toolName === undefined ? "heading" : "tool",
      start: heading.line.start,
      end,
      text: text.slice(heading.line.start, end),
      children: [],
    };
    if (parent === undefined) roots.push(section);
    else parent.children.push(section);
    stack.push({ level: heading.level, section });
  }

  for (const line of lines) {
    const match = /^- ([^\n]+?):\s+/.exec(line.value);
    if (match === null) continue;
    const skillName = match[1];
    if (skillName === undefined || !isInsideSkillsHeading(line.start, roots)) continue;
    const parent = deepestSectionAt(line.start, roots);
    if (parent === undefined) continue;
    parent.children.push({
      id: `skill:${skillName}`,
      label: skillName,
      kind: "skill",
      start: line.start,
      end: line.end,
      text: text.slice(line.start, line.end),
      children: [],
    });
  }

  return roots;
}

function sourceLines(text: string): Array<{ value: string; start: number; end: number }> {
  const lines: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ value: text.slice(start, newline === -1 ? end : newline), start, end });
    start = end;
  }
  return lines;
}

function nextBoundary(
  headings: Array<{ line: { start: number }; level: number }>,
  index: number,
  level: number,
  fallback: number,
): number {
  return headings.slice(index + 1).find((heading) => heading.level <= level)?.line.start ?? fallback;
}

function stripHeadingMarkup(value: string): string {
  return value.replace(/^`|`$/g, "").trim();
}

function toolHeadingName(rawLabel: string): string | undefined {
  const match = /^`([a-zA-Z0-9_]+)`$/.exec(rawLabel);
  return match?.[1];
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

function deepestSectionAt(offset: number, sections: ContentSection[]): ContentSection | undefined {
  for (const section of sections) {
    if (offset < section.start || offset >= section.end) continue;
    return deepestSectionAt(offset, section.children) ?? section;
  }
  return undefined;
}

function isInsideSkillsHeading(offset: number, sections: ContentSection[]): boolean {
  const ancestors = sectionAncestorsAt(offset, sections);
  return ancestors.some((section) => section.label.toLowerCase() === "available skills");
}

function sectionAncestorsAt(offset: number, sections: ContentSection[]): ContentSection[] {
  for (const section of sections) {
    if (offset < section.start || offset >= section.end) continue;
    return [section, ...sectionAncestorsAt(offset, section.children)];
  }
  return [];
}

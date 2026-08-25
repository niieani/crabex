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

interface SourceLine {
  value: string;
  start: number;
  end: number;
}

interface MarkdownHeading {
  line: SourceLine;
  level: number;
  label: string;
  toolName?: string;
}

interface GeneratedToolAnchor {
  start: number;
  footerEnd: number;
  toolName: string;
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

export function classifyMessage(
  role: string | undefined,
  text: string,
): ContentClassification | undefined {
  const found = MESSAGE_CLASSIFICATIONS.find(
    (classification) => classification.role === role && text.startsWith(classification.prefix),
  );
  return found === undefined ? undefined : { id: found.id, label: found.label };
}

export function markdownSections(text: string, parentId: string): ContentSection[] {
  const lines = sourceLines(text);
  const parsedHeadings = markdownHeadings(lines);
  const headings =
    parentId === "tool:functions.exec"
      ? generatedExecHeadings(lines, parsedHeadings)
      : parsedHeadings;
  return buildSectionTree(text, parentId, headings, lines);
}

function buildSectionTree(
  text: string,
  parentId: string,
  headings: MarkdownHeading[],
  lines: SourceLine[],
): ContentSection[] {
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

function markdownHeadings(lines: SourceLine[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line.value);
    if (fenceMatch !== null) {
      const run = fenceMatch[1] ?? "";
      const marker = run[0] ?? "";
      if (fence === undefined) fence = { marker, length: run.length };
      else if (marker === fence.marker && run.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.value);
    if (match === null) continue;
    const rawLabel = (match[2] ?? "").trim();
    headings.push({
      line,
      level: match[1]?.length ?? 1,
      label: stripHeadingMarkup(rawLabel),
      toolName: toolHeadingName(rawLabel),
    });
  }

  return headings;
}

function generatedExecHeadings(
  lines: SourceLine[],
  headings: MarkdownHeading[],
): MarkdownHeading[] {
  // Codex concatenates arbitrary tool-description Markdown beneath generated H3 headings.
  // Declaration footers are the stable delimiters; raw heading levels inside a tool are not.
  const anchors = generatedToolAnchors(lines, headings);
  if (anchors.length === 0) return headings;

  const anchorsByStart = new Map(anchors.map((anchor) => [anchor.start, anchor]));
  const namespaceHeadings = new Map<number, string>();
  for (const heading of headings) {
    if (heading.level !== 2 || isInsideGeneratedTool(heading.line.start, anchors)) continue;
    const nextTool = anchors.find((anchor) => anchor.start > heading.line.start);
    if (nextTool === undefined) continue;
    const namespace = normalizeCodeModeIdentifier(heading.label);
    if (nextTool.toolName.startsWith(`${namespace}__`)) {
      namespaceHeadings.set(heading.line.start, namespace);
    }
  }

  const toolLevels = new Map<number, number>();
  for (const anchor of anchors) {
    const namespace = [...namespaceHeadings.entries()]
      .filter(([start]) => start < anchor.start)
      .at(-1)?.[1];
    toolLevels.set(
      anchor.start,
      namespace !== undefined && anchor.toolName.startsWith(`${namespace}__`) ? 2 : 1,
    );
  }

  const minimumToolHeadingLevels = new Map<number, number>();
  for (const anchor of anchors) {
    const levels = headings
      .filter(
        (heading) =>
          heading.line.start > anchor.start &&
          heading.line.start < anchor.footerEnd &&
          !anchorsByStart.has(heading.line.start),
      )
      .map((heading) => heading.level);
    if (levels.length > 0) minimumToolHeadingLevels.set(anchor.start, Math.min(...levels));
  }

  return headings.map((heading) => {
    const anchor = anchorsByStart.get(heading.line.start);
    if (anchor !== undefined) {
      return { ...heading, level: toolLevels.get(anchor.start) ?? 1, toolName: anchor.toolName };
    }
    if (namespaceHeadings.has(heading.line.start)) {
      return { ...heading, level: 1, toolName: undefined };
    }

    const owner = anchors.find(
      (candidate) =>
        heading.line.start > candidate.start && heading.line.start < candidate.footerEnd,
    );
    if (owner !== undefined) {
      const toolLevel = toolLevels.get(owner.start) ?? 1;
      const minimumLevel = minimumToolHeadingLevels.get(owner.start) ?? heading.level;
      return {
        ...heading,
        level: toolLevel + 1 + heading.level - minimumLevel,
        toolName: undefined,
      };
    }

    return { ...heading, toolName: undefined };
  });
}

function generatedToolAnchors(
  lines: SourceLine[],
  headings: MarkdownHeading[],
): GeneratedToolAnchor[] {
  const anchors: GeneratedToolAnchor[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.value.trim() !== "exec tool declaration:") continue;
    const openingFence = lines[index + 1];
    const declaration = lines[index + 2];
    if (openingFence?.value.trim() !== "```ts" || declaration === undefined) continue;
    const declarationMatch = /^declare const tools: \{ ([a-zA-Z_$][a-zA-Z0-9_$]*)\(/.exec(
      declaration.value,
    );
    const toolName = declarationMatch?.[1];
    if (toolName === undefined) continue;
    const closingFence = lines
      .slice(index + 3)
      .find((candidate) => candidate.value.trim() === "```");
    if (closingFence === undefined) continue;
    const heading = headings
      .filter(
        (candidate) =>
          candidate.level === 3 &&
          candidate.toolName === toolName &&
          candidate.line.start < line.start,
      )
      .at(-1);
    if (heading === undefined || anchors.some((anchor) => anchor.start === heading.line.start)) {
      continue;
    }
    anchors.push({ start: heading.line.start, footerEnd: closingFence.end, toolName });
  }

  return anchors.sort((left, right) => left.start - right.start);
}

function isInsideGeneratedTool(offset: number, anchors: GeneratedToolAnchor[]): boolean {
  return anchors.some((anchor) => offset > anchor.start && offset < anchor.footerEnd);
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
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
  return (
    headings.slice(index + 1).find((heading) => heading.level <= level)?.line.start ?? fallback
  );
}

function stripHeadingMarkup(value: string): string {
  return toolHeadingName(value) ?? value.replace(/^`|`$/g, "").trim();
}

function toolHeadingName(rawLabel: string): string | undefined {
  const match = /^`([a-zA-Z_$][a-zA-Z0-9_$]*)`(?: \(`[^`]+`\))?$/.exec(rawLabel);
  return match?.[1];
}

function normalizeCodeModeIdentifier(value: string): string {
  const normalized = Array.from(value)
    .map((character, index) => {
      const valid =
        character === "_" ||
        character === "$" ||
        (index === 0 ? /[a-zA-Z]/.test(character) : /[a-zA-Z0-9]/.test(character));
      return valid ? character : "_";
    })
    .join("");
  return normalized || "_";
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

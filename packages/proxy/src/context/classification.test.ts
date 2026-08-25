import { describe, expect, it } from "vite-plus/test";

import { classifyMessage, markdownSections } from "./classification.ts";

describe("message classification", () => {
  it.each([
    ["developer", "You are Codex, an agent", "codex_base", "Codex base instructions"],
    ["developer", "<skills_instructions>\n## Skills", "skills", "Skills instructions"],
    ["developer", "<permissions instructions>\npolicy", "permissions", "Permissions"],
    ["developer", "<apps_instructions>\napps", "apps", "Apps instructions"],
    ["developer", "<plugins_instructions>\nplugins", "plugins", "Plugins instructions"],
    ["user", "<recommended_plugins>\nplugins", "recommended_plugins", "Recommended plugins"],
    [
      "user",
      "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>",
      "project_instructions",
      "Project instructions",
    ],
    ["user", "<environment_context>\n<context>", "environment", "Environment context"],
  ])("classifies %s content as %s", (role, text, id, label) => {
    expect(classifyMessage(role, text)).toEqual({ id: `segment:${id}`, label });
  });

  it("leaves unknown text unclassified", () => {
    expect(classifyMessage("user", "hi")).toBeUndefined();
  });
});

describe("markdownSections", () => {
  it("builds heading subtrees with exact source ranges", () => {
    const text = "intro\n# One\na\n## Child\nb\n# Two\nc";

    const sections = markdownSections(text, "segment:fixture");

    expect(sections).toMatchObject([
      {
        id: "section:segment:fixture/one",
        label: "One",
        text: "# One\na\n## Child\nb\n",
        children: [
          {
            id: "section:segment:fixture/one/child",
            label: "Child",
            text: "## Child\nb\n",
          },
        ],
      },
      { id: "section:segment:fixture/two", label: "Two", text: "# Two\nc" },
    ]);
  });

  it("recognizes individual skills without parsing their prose", () => {
    const text = [
      "<skills_instructions>",
      "## Skills",
      "### Available skills",
      "- imagegen: Generate images. (file: /skill)",
      "- browser:control-in-app-browser: Control browser. (file: /browser)",
      "</skills_instructions>",
    ].join("\n");

    const sections = markdownSections(text, "segment:skills");
    const available = sections[0]?.children[0];

    expect(available?.children).toMatchObject([
      { id: "skill:imagegen", label: "imagegen" },
      {
        id: "skill:browser:control-in-app-browser",
        label: "browser:control-in-app-browser",
      },
    ]);
  });

  it("recognizes generated tool declaration sections by heading", () => {
    const text = [
      "intro",
      "### `apply_patch`",
      "Apply changes.",
      "### `mcp__codex_apps__github_get_issue_comment_reactions`",
      "Read reactions.",
    ].join("\n");

    expect(markdownSections(text, "tool:functions.exec")).toMatchObject([
      { id: "tool:apply_patch", label: "apply_patch", kind: "tool" },
      {
        id: "tool:mcp__codex_apps__github_get_issue_comment_reactions",
        label: "mcp__codex_apps__github_get_issue_comment_reactions",
        kind: "mcp",
      },
    ]);
  });

  it("keeps generated exec tools structural when descriptions contain higher-level headings", () => {
    const text = [
      "### `read_mcp_resource`",
      "Read a resource.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { read_mcp_resource(args: {}): Promise<unknown>; };",
      "```",
      "",
      "### `request_plugin_install`",
      "# Suggest a recommended plugin installation",
      "Details.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { request_plugin_install(args: {}): Promise<unknown>; };",
      "```",
      "",
      "### `update_plan`",
      "Updates the plan.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { update_plan(args: {}): Promise<unknown>; };",
      "```",
    ].join("\n");

    const sections = markdownSections(text, "tool:functions.exec");

    expect(sections).toMatchObject([
      { id: "tool:read_mcp_resource", children: [] },
      {
        id: "tool:request_plugin_install",
        children: [
          {
            id: "tool:request_plugin_install/suggest-a-recommended-plugin-installation",
            label: "Suggest a recommended plugin installation",
            kind: "heading",
          },
        ],
      },
      { id: "tool:update_plan", children: [] },
    ]);
    expect(sections[1]?.text).toContain("declare const tools: { request_plugin_install");
    expect(sections[1]?.text).not.toContain("### `update_plan`");
  });

  it("keeps arbitrary Markdown headings inside the generated tool that owns them", () => {
    const text = [
      "## web",
      "Tools in the web namespace.",
      "",
      "### `web__run`",
      "Tool for accessing the internet.",
      "",
      "---",
      "",
      "## Examples of different commands available in this tool",
      "Examples.",
      "",
      "### `illustrative_heading`",
      "Not a generated tool declaration.",
      "",
      "## Usage hints",
      "Hints.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { web__run(args: {}): Promise<unknown>; };",
      "```",
    ].join("\n");

    expect(markdownSections(text, "tool:functions.exec")).toMatchObject([
      {
        label: "web",
        kind: "heading",
        children: [
          {
            id: "tool:web__run",
            kind: "tool",
            children: [
              {
                label: "Examples of different commands available in this tool",
                kind: "heading",
                children: [{ label: "illustrative_heading", kind: "heading" }],
              },
              { label: "Usage hints", kind: "heading" },
            ],
          },
        ],
      },
    ]);
  });
});

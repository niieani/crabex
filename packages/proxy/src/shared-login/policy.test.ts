import { describe, expect, it } from "vite-plus/test";

import { inspectFrame, inspectRequestBody, upstreamTarget } from "./policy.ts";

const none = new URLSearchParams();
const RESPONSES = "/backend-api/codex/responses";
const SEARCH = "/backend-api/codex/alpha/search";
const GENERATIONS = "/backend-api/codex/images/generations";
const EDITS = "/backend-api/codex/images/edits";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("Shared Login routes", () => {
  it.each([
    ["POST", "/v1/responses", false, "/backend-api/codex/responses"],
    ["GET", "/v1/responses", true, "/backend-api/codex/responses"],
    ["POST", "/v1/alpha/search", false, "/backend-api/codex/alpha/search"],
    ["GET", "/v1/models", false, "/backend-api/codex/models"],
    ["POST", "/v1/images/generations", false, GENERATIONS],
    ["POST", "/v1/images/edits", false, EDITS],
  ])("allows %s %s", (method, path, webSocket, expected) => {
    expect(upstreamTarget(method, path, none, webSocket)).toBe(expected);
  });

  it.each([
    ["GET", "/backend-api/ps/mcp", false],
    ["POST", "/backend-api/codex/responses", false],
    ["POST", "/v1/responses/../../ps/mcp", false],
    ["POST", "/v1//responses", false],
    ["POST", "/v1/Responses", false],
    ["GET", "/v1/responses", false],
    ["POST", "/v1/responses", true],
    ["GET", "/v1/images/generations", false],
    ["POST", "/v1/images/variations", false],
    ["POST", "/v1/images/generations", true],
    ["POST", "/v1/responses/compact", false],
    ["GET", "/__crabex/api/proxy-config", false],
    ["GET", "/", false],
  ])("refuses %s %s", (method, path, webSocket) => {
    expect(upstreamTarget(method, path, none, webSocket)).toBeUndefined();
  });

  it("forwards only the query parameters a route declares", () => {
    const search = new URLSearchParams({ client_version: "1.2.3", redirect: "x" });
    expect(upstreamTarget("GET", "/v1/models", search, false)).toBe(
      "/backend-api/codex/models?client_version=1.2.3",
    );
    expect(upstreamTarget("POST", "/v1/responses", search, false)).toBe(
      "/backend-api/codex/responses",
    );
  });
});

describe("Shared Login body policy", () => {
  it("forwards the checked parse of the tools Codex declares", () => {
    const body = {
      model: "gpt-example",
      input: [
        { type: "message", content: 'mention {"type":"mcp","server_url":"x"}' },
        { type: "tool_search_output", tools: [{ type: "function", name: "found" }] },
      ],
      tools: [
        { type: "function", name: "shell" },
        { type: "web_search" },
        { type: "tool_search" },
        { type: "custom", name: "apply_patch" },
        { type: "namespace", name: "local", tools: [{ type: "function", name: "a" }] },
      ],
      tool_choice: "auto",
    };
    expect(inspectRequestBody(bytes(body), RESPONSES)).toEqual({ forward: JSON.stringify(body) });
  });

  it.each([
    ["hosted mcp", { tools: [{ type: "mcp", server_label: "x" }] }],
    ["unknown type", { tools: [{ type: "connector", connector_id: "drive" }] }],
    ["other case", { tools: [{ type: "MCP" }] }],
    ["missing type", { tools: [{ name: "x" }] }],
    ["nested", { tools: [{ type: "namespace", tools: [{ type: "mcp" }] }] }],
    ["tools object", { tools: { type: "mcp" } }],
    ["tool choice", { tool_choice: { type: "mcp", server_label: "x" } }],
    [
      "tool search output",
      { input: [{ type: "tool_search_output", tools: [{ type: "mcp", server_url: "x" }] }] },
    ],
    ["mcp input item", { input: [{ type: "mcp_approval_response", approve: true }] }],
    [
      "connector field on an allowed type",
      { tools: [{ type: "web_search", connector_id: "drive" }] },
    ],
    ["server url on a function", { tools: [{ type: "function", name: "f", server_url: "x" }] }],
    ["unknown top-level field", { model: "m", prompt: { id: "pmpt_1" } }],
    ["case variant", { model: "m", Tools: [{ type: "mcp" }] }],
    ["type on an HTTP body", { type: "response.create", model: "m" }],
  ])("refuses %s", (_label, body) => {
    expect(inspectRequestBody(bytes(body), RESPONSES)).toEqual({ refused: expect.any(String) });
  });

  it("resolves duplicate keys before forwarding, so upstream sees what was checked", () => {
    const text = '{"tools":[{"type":"function","name":"x"}],"tools":[{"type":"mcp"}]}';
    expect(inspectRequestBody(new TextEncoder().encode(text), RESPONSES)).toEqual({
      refused: expect.stringContaining("mcp"),
    });
    const safe = '{"tools":[{"type":"mcp"}],"tools":[{"type":"function","name":"x"}]}';
    expect(inspectRequestBody(new TextEncoder().encode(safe), RESPONSES)).toEqual({
      forward: '{"tools":[{"type":"function","name":"x"}]}',
    });
  });

  it("refuses invalid UTF-8 and deep nesting", () => {
    expect(inspectRequestBody(new Uint8Array([0x7b, 0xff, 0x7d]), RESPONSES)).toEqual({
      refused: expect.stringContaining("UTF-8"),
    });
    let tools: unknown = [{ type: "function" }];
    for (let depth = 0; depth < 20; depth += 1) tools = [{ type: "namespace", tools }];
    expect(inspectRequestBody(bytes({ tools }), RESPONSES)).toEqual({
      refused: expect.stringContaining("nested"),
    });
  });

  it("checks search requests against the search fields", () => {
    const search = { id: "s1", model: "m", input: "query", settings: {} };
    expect(inspectRequestBody(bytes(search), SEARCH)).toEqual({ forward: JSON.stringify(search) });
    expect(inspectRequestBody(bytes({ ...search, tools: [] }), SEARCH)).toEqual({
      refused: expect.stringContaining("tools"),
    });
  });

  it.each(["not json", "[]", "null"])("refuses unreadable payload %s", (text) => {
    expect(inspectRequestBody(new TextEncoder().encode(text), RESPONSES)).toEqual({
      refused: expect.stringContaining("JSON object"),
    });
  });

  it("accepts only response.create frames", () => {
    expect(inspectFrame(JSON.stringify({ type: "response.create", model: "m" }))).toEqual({
      forward: '{"type":"response.create","model":"m"}',
    });
    expect(inspectFrame(JSON.stringify({ type: "session.update", tools: [] }))).toEqual({
      refused: expect.stringContaining("response.create"),
    });
    expect(
      inspectFrame(JSON.stringify({ type: "response.create", tools: [{ type: "mcp" }] })),
    ).toEqual({ refused: expect.any(String) });
  });
});

describe("Shared Login image policy", () => {
  const generation = {
    prompt: "a red fox",
    model: "gpt-image-2",
    background: "opaque",
    quality: "auto",
    size: "auto",
  };

  it("forwards the generation and edit requests Codex's image tool sends", () => {
    const gif = { ...generation, output_format: "gif", frame_count: 4, frame_duration_ms: 200 };
    expect(inspectRequestBody(bytes(gif), GENERATIONS)).toEqual({ forward: JSON.stringify(gif) });
    const edit = { ...generation, images: [{ image_url: PNG }, { image_url: PNG }] };
    expect(inspectRequestBody(bytes(edit), EDITS)).toEqual({ forward: JSON.stringify(edit) });
  });

  it.each([
    ["an unknown field", GENERATIONS, { ...generation, user: "someone" }],
    ["images on a generation", GENERATIONS, { ...generation, images: [{ image_url: PNG }] }],
    ["a missing prompt", GENERATIONS, { model: "gpt-image-2" }],
    ["an edit without images", EDITS, generation],
    ["a ChatGPT file reference", EDITS, { ...generation, images: [{ file_id: "file-abc" }] }],
    ["a remote image URL", EDITS, { ...generation, images: [{ image_url: "https://x/y.png" }] }],
    ["a non-image data URL", EDITS, { ...generation, images: [{ image_url: "data:text/html,x" }] }],
    [
      "extra fields on an image",
      EDITS,
      { ...generation, images: [{ image_url: PNG, file_id: "file-abc" }] },
    ],
    ["more than five images", EDITS, { ...generation, images: Array(6).fill({ image_url: PNG }) }],
  ])("refuses %s", (_label, path, body) => {
    expect(inspectRequestBody(bytes(body), path)).toEqual({ refused: expect.any(String) });
  });
});

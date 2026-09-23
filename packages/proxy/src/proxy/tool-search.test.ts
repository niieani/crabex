import { describe, expect, it } from "vite-plus/test";
import { LoadedToolRegistry, toolSearchResultText } from "./tool-search.ts";

const search = {
  type: "tool_search",
  execution: "client",
  description: "Find deferred tools",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};
const lookup = {
  type: "namespace",
  name: "inventory",
  tools: [
    {
      type: "function",
      name: "lookup_item",
      description: "Look up a SKU",
      defer_loading: true,
      parameters: { type: "object", properties: { sku: { type: "string" } } },
    },
  ],
};
const discovery = {
  type: "tool_search_output",
  call_id: "search_1",
  status: "completed",
  execution: "client",
  tools: [lookup],
};
const user = { type: "message", role: "user", content: "Find an inventory lookup tool" };

describe("loaded tool discovery", () => {
  it("merges and deduplicates discoveries across stored deltas and HTTP fallback", () => {
    const registry = new LoadedToolRegistry();
    const first = { input: [user], tools: [search] };
    expect(registry.prepare("flash", "thread-1", first, first).tools).toEqual([search]);

    const second = {
      input: [user, { type: "tool_search_call", call_id: "search_1" }, discovery],
      tools: [search],
    };
    const result = registry.prepare("flash", "thread-1", second, {
      input: [discovery],
      tools: [search],
      previous_response_id: "resp_1",
    });
    expect(result.tools).toMatchObject([
      search,
      { type: "namespace", name: "inventory", tools: [{ name: "lookup_item" }] },
    ]);
    expect(JSON.stringify(result.tools)).not.toContain("defer_loading");

    const later = registry.prepare(
      "flash",
      "thread-1",
      { input: [] },
      {
        input: [{ type: "function_call_output", call_id: "lookup_1", output: "ok" }],
        tools: [search],
        previous_response_id: "resp_2",
      },
    );
    expect(later.tools).toEqual(result.tools);

    registry.clear("thread-1");
    const replay = registry.prepare(
      "flash",
      "thread-1",
      { input: [user, discovery, discovery], tools: [search] },
      { input: [user, discovery, discovery], tools: [search] },
    );
    expect((replay.tools as { tools?: unknown[] }[])[1]?.tools).toHaveLength(1);
  });

  it("clears discoveries at explicit and inferred compaction boundaries", () => {
    const registry = new LoadedToolRegistry();
    registry.prepare(
      "flash",
      "thread-1",
      { input: [discovery], tools: [search] },
      {
        input: [discovery],
        tools: [search],
      },
    );
    const compacted = {
      input: [discovery, { type: "compaction", encrypted_content: "opaque" }, user],
      tools: [search],
    };
    expect(registry.prepare("flash", "thread-1", compacted, compacted).tools).toEqual([search]);

    registry.prepare(
      "flash",
      "thread-1",
      { input: [discovery], tools: [search] },
      {
        input: [discovery],
        tools: [search],
      },
    );
    const localSummary = {
      input: [{ type: "message", role: "user", content: "Summary of earlier conversation" }],
      tools: [search],
    };
    expect(registry.prepare("flash", "thread-1", localSummary, localSummary).tools).toEqual([
      search,
    ]);
  });

  it("fails visibly after registry loss on a delta-only continuation", () => {
    let now = 0;
    const registry = new LoadedToolRegistry(() => now);
    const full = { input: [discovery], tools: [search] };
    registry.prepare("flash", "thread-1", full, full);
    const delta = {
      input: [{ type: "function_call_output", call_id: "lookup_1", output: "ok" }],
      tools: [search],
      previous_response_id: "resp_1",
    };
    now = 30 * 60_000;
    expect(() => registry.prepare("flash", "thread-1", delta, delta)).toThrow(
      'model route "flash" lost loaded tools for a delta-only continuation',
    );
    expect(() => registry.prepare("flash", undefined, delta, delta)).toThrow(
      "delta-only continuation",
    );
  });

  it("returns concise names and descriptions while schemas stay in the tools list", () => {
    expect(toolSearchResultText(discovery)).toContain("inventory.lookup_item: Look up a SKU");
    expect(toolSearchResultText({ status: "completed", tools: [] })).toBe(
      "No matching tools were found.",
    );
    expect(toolSearchResultText({ status: "failed", tools: [] })).toBe("Tool discovery failed.");
  });
});

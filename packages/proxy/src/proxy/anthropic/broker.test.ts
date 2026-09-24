import { afterEach, describe, expect, it } from "vite-plus/test";
import { modelRouteFromConfig, responseTargetUrl } from "../../routing/model-routes.ts";
import { TargetBreakers } from "../../routing/failover.ts";
import { parseSseEvents } from "../responses-bridge.ts";
import { brokerRouteFor, brokerResult } from "../search-broker.ts";
import { anthropicFetch } from "./adapter.ts";
import { prepareAnthropic } from "./request.ts";
import type { Json } from "./envelope.ts";

const key = new Uint8Array(32).fill(37);
const model = {
  slug: "claude-test",
  display_name: "Claude test",
  description: "Test route",
  priority: 1,
  template_slug: "gpt-6-astra",
};
const exits: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const exit of exits.splice(0).reverse()) await exit();
  delete process.env.BROKER_TEST_KEY;
});

describe("Anthropic web search broker", () => {
  it("selects only a usable configured Responses route", () => {
    const claude = modelRouteFromConfig({
      api: "anthropic-messages",
      authorization_env: "BROKER_TEST_KEY",
      upstream: "https://claude.example/anthropic",
      model,
      tool_policy: { web_search: "broker" },
    });
    expect(() => brokerRouteFor([claude], "missing", claude.model.slug)).toThrow('route "missing"');
    expect(() => brokerRouteFor([claude], claude.model.slug, claude.model.slug)).toThrow(
      'route "claude-test"',
    );
    expect(() =>
      prepareAnthropic(
        {
          model: claude.model.slug,
          input: [
            { role: "user", content: "Search" },
            { type: "web_search_call", action: { type: "search", query: "fact" } },
          ],
        },
        claude,
        key,
      ),
    ).toThrow("missing its encrypted broker marker");
  });

  it("extracts cited sources without copying citation offsets", () => {
    expect(
      brokerResult({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "A cited fact.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://science.nasa.gov/mars/",
                    title: "NASA Mars",
                    start_index: 0,
                    end_index: 5,
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
    ).toEqual({
      text: "A cited fact.",
      sources: [{ url: "https://science.nasa.gov/mars/", title: "NASA Mars" }],
      usage: { inputTokens: 12, outputTokens: 5 },
    });
  });

  it("searches inside one response, resumes Claude, and replays the exact broker exchange", async () => {
    const claudeBodies: Json[] = [];
    const brokerBodies: Json[] = [];
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Json;
        if (path === "/openai/responses") {
          brokerBodies.push(body);
          expect(request.headers.get("authorization")).toBe("Bearer search-secret");
          return Response.json({
            status: "completed",
            output: [
              { type: "web_search_call", action: { type: "search", query: "Mars" } },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Mars has Olympus Mons.",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://science.nasa.gov/mars/facts/",
                        title: "NASA Mars Facts",
                        start_index: 0,
                        end_index: 4,
                      },
                    ],
                  },
                ],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 8 },
          });
        }
        claudeBodies.push(body);
        expect(request.headers.get("authorization")).toBe("Bearer claude-secret");
        if (claudeBodies.length === 1)
          return Response.json({
            type: "message",
            content: [
              { type: "thinking", thinking: "Need a source", signature: "signed-thinking" },
              {
                type: "tool_use",
                id: "toolu_search_1",
                name: "web_search",
                input: { query: "Mars" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 11, output_tokens: 4 },
          });
        return Response.json({
          type: "message",
          content: [
            { type: "text", text: "Mars has Olympus Mons: https://science.nasa.gov/mars/facts/" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 7 },
        });
      },
    });
    exits.push(() => gateway.stop(true));
    process.env.BROKER_TEST_KEY = "search-secret";
    const claude = modelRouteFromConfig({
      api: "anthropic-messages",
      authorization_env: "CLAUDE_TEST_KEY",
      upstream: `${gateway.url.origin}/anthropic`,
      model,
      tool_policy: { web_search: "broker" },
    });
    const search = modelRouteFromConfig({
      authorization_env: "BROKER_TEST_KEY",
      upstream: `${gateway.url.origin}/openai`,
      transport: "http",
      model: { ...model, slug: "gpt-6-luna" },
    });
    const results: unknown[] = [];
    const payload = {
      model: claude.model.slug,
      input: [{ role: "user", content: "Find one Mars fact with a source" }],
      tools: [{ type: "web_search", external_web_access: false }],
      stream: true,
    };
    const response = await anthropicFetch(claude, key, undefined, false, {
      route: brokerRouteFor([claude, search], "gpt-6-luna", claude.model.slug),
      breakers: new TargetBreakers(),
      onResult: (result) => results.push(result),
    })(responseTargetUrl(claude, ""), {
      method: "POST",
      headers: { authorization: "Bearer claude-secret" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    const events = (await Array.fromAsync(parseSseEvents(response.body!))).map(
      (event) => JSON.parse(event) as Json,
    );
    expect(events.filter((event) => event.type === "response.created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    const completed = events.at(-1)!.response as Json;
    const output = completed.output as Json[];
    expect(output.map((item) => item.type)).toEqual([
      "reasoning",
      "web_search_call",
      "reasoning",
      "message",
    ]);
    expect(output[1]).toMatchObject({ action: { type: "search", query: "Mars" } });
    expect(JSON.stringify(output)).toContain("science.nasa.gov/mars/facts/");
    expect(completed.usage).toMatchObject({ input_tokens: 31, output_tokens: 11 });
    expect(results).toMatchObject([{ usage: { inputTokens: 100, outputTokens: 8 } }]);
    expect(brokerBodies[0]).toMatchObject({
      model: "gpt-6-luna",
      tools: [{ type: "web_search", external_web_access: false }],
      reasoning: { effort: "low" },
    });
    expect(claudeBodies[0]!.tools).toMatchObject([{ name: "web_search" }]);
    expect(JSON.stringify(claudeBodies[0]!.tools)).toContain("cached web results");
    expect(JSON.stringify(claudeBodies[1]!.messages)).toContain("NASA Mars Facts");
    const replay = prepareAnthropic(
      { ...payload, input: [...payload.input, ...output, { role: "user", content: "One more?" }] },
      claude,
      key,
    );
    expect(JSON.stringify(replay.body.messages)).toContain("signed-thinking");
    expect(replay.body.messages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "thinking" }, { type: "tool_use" }] },
      { role: "user", content: [{ type: "tool_result" }] },
      { role: "assistant", content: [{ type: "text" }] },
      { role: "user" },
    ]);
    const compact = prepareAnthropic(
      {
        ...payload,
        input: [
          ...payload.input,
          ...output,
          { role: "user", content: "Summarize" },
          { type: "compaction_trigger" },
        ],
      },
      claude,
      key,
    );
    expect(JSON.stringify(compact.body.messages)).toContain("NASA Mars Facts");
  });
});

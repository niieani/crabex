import { fetchWithFailover, type TargetBreakers } from "../routing/failover.ts";
import {
  authorizationFor,
  responseTargetUrl,
  routedHeaders,
  type ModelRoute,
} from "../routing/model-routes.ts";
import { parseSseEvents } from "./responses-bridge.ts";

const BROKER_TIMEOUT_MS = 45_000;
const MAX_BROKER_BYTES = 4 * 1024 * 1024;

export interface BrokerResult {
  text: string;
  sources: { url: string; title: string }[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

export class SearchBrokerRouteError extends Error {}

export type BrokerRouteEligibility =
  | { eligible: true }
  | {
      eligible: false;
      code: "disabled" | "api" | "web_search" | "authorization";
      reason: string;
    };

/** Shared by broker execution and the route editor's read-only eligibility metadata. */
export function brokerRouteEligibility(
  route: ModelRoute,
  environment: Readonly<Record<string, string | undefined>>,
): BrokerRouteEligibility {
  const slug = route.model.slug;
  if (!route.enabled)
    return {
      eligible: false,
      code: "disabled",
      reason: `Search broker route "${slug}" is disabled.`,
    };
  if (route.api === "anthropic-messages")
    return {
      eligible: false,
      code: "api",
      reason: `Search broker route "${slug}" must use OpenAI Responses.`,
    };
  if (route.toolPolicy.web_search !== "pass")
    return {
      eligible: false,
      code: "web_search",
      reason: `Search broker route "${slug}" needs web_search: pass (effective: ${route.toolPolicy.web_search}).`,
    };
  try {
    authorizationFor(route, environment);
  } catch {
    return {
      eligible: false,
      code: "authorization",
      reason: `Search broker route "${slug}" has no usable authorization.`,
    };
  }
  return { eligible: true };
}

/** The policy alone does not make ordinary Claude turns depend on the broker. */
export function needsSearchBroker(route: ModelRoute, tools: unknown): boolean {
  return (
    route.toolPolicy.web_search === "broker" &&
    Array.isArray(tools) &&
    tools.some((tool) => record(tool) && tool.type === "web_search")
  );
}

export function brokerRouteFor(
  routes: readonly ModelRoute[],
  slug: string,
  anthropicSlug: string,
): ModelRoute {
  const route = routes.find((candidate) => candidate.model.slug === slug);
  if (route === undefined)
    throw new SearchBrokerRouteError(
      `model route "${anthropicSlug}" web_search broker requires usable OpenAI Responses route "${slug}" with web_search: "pass"`,
    );
  const eligibility = brokerRouteEligibility(route, process.env);
  if (!eligibility.eligible && eligibility.code === "authorization") {
    throw new SearchBrokerRouteError(
      `model route "${anthropicSlug}" web_search broker route "${slug}" has no usable authorization`,
    );
  }
  if (!eligibility.eligible)
    throw new SearchBrokerRouteError(
      `model route "${anthropicSlug}" web_search broker requires usable OpenAI Responses route "${slug}" with web_search: "pass"`,
    );
  return route;
}

export async function runSearchBroker(
  route: ModelRoute,
  query: string,
  breakers: TargetBreakers,
  signal?: AbortSignal,
  declaration?: Record<string, unknown>,
): Promise<BrokerResult> {
  const timeout = AbortSignal.timeout(BROKER_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const authorization = authorizationFor(route, process.env);
    const response = await fetchWithFailover({
      route,
      breakers,
      signal: combined,
      requestFor: (target) => ({
        url: responseTargetUrl(route, ""),
        init: {
          method: "POST",
          headers: routedHeaders(
            { "content-type": "application/json", accept: "text/event-stream" },
            authorization,
          ),
          body: JSON.stringify({
            model: target.upstreamModel ?? route.model.slug,
            input: [{ role: "user", content: `Search the web for: ${query}` }],
            instructions:
              "Use web search. Return a concise factual answer with source URLs. Do not invent sources.",
            tools: [webSearchTool(declaration)],
            tool_choice: "required",
            reasoning: { effort: "low" },
            stream: true,
            store: false,
          }),
          redirect: "manual",
        },
      }),
    });
    if (!response.response.ok) {
      const detail = (await response.response.text()).slice(0, 500);
      throw new Error(`HTTP ${response.response.status}: ${detail}`);
    }
    const completed = await completedResponse(response.response);
    return brokerResult(completed);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      text: "",
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function webSearchTool(declaration?: Record<string, unknown>): Record<string, unknown> {
  if (!declaration) return { type: "web_search" };
  const fields = [
    "external_web_access",
    "indexed_web_access",
    "filters",
    "user_location",
    "search_context_size",
    "search_content_types",
  ];
  return {
    type: "web_search",
    ...Object.fromEntries(
      fields
        .filter((field) => declaration[field] !== undefined)
        .map((field) => [field, declaration[field]]),
    ),
  };
}

async function completedResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const value: unknown = await response.json();
    if (!record(value)) throw new Error("Invalid broker response");
    return value;
  }
  if (!response.body) throw new Error("Broker response has no body");
  let bytes = 0;
  for await (const data of parseSseEvents(response.body)) {
    bytes += Buffer.byteLength(data);
    if (bytes > MAX_BROKER_BYTES) throw new Error("Broker response exceeds 4 MiB");
    const event: unknown = JSON.parse(data);
    if (!record(event)) continue;
    if (event.type === "response.completed" && record(event.response)) return event.response;
    if (event.type === "response.failed" || event.type === "response.incomplete")
      throw new Error(`Broker ${event.type}: ${JSON.stringify(event.response).slice(0, 500)}`);
  }
  throw new Error("Broker stream ended without response.completed");
}

export function brokerResult(response: Record<string, unknown>): BrokerResult {
  const sources = new Map<string, string>();
  const paragraphs: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!record(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!record(part) || part.type !== "output_text") continue;
      if (typeof part.text === "string") paragraphs.push(part.text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (!record(annotation) || annotation.type !== "url_citation") continue;
        if (typeof annotation.url !== "string" || !/^https?:\/\//.test(annotation.url)) continue;
        sources.set(
          annotation.url,
          typeof annotation.title === "string" ? annotation.title : annotation.url,
        );
      }
    }
  }
  const usage = record(response.usage) ? response.usage : {};
  return {
    text: paragraphs.join("\n").slice(0, 4000),
    sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })),
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    },
  };
}

export function brokerToolResult(result: BrokerResult): string {
  if (result.error) return `Web search failed: ${result.error}`;
  const sources = result.sources.map(({ title, url }) => `- ${title}: ${url}`).join("\n");
  return `${result.text || "No answer text returned."}${sources ? `\n\nSources:\n${sources}` : "\n\nNo source URLs returned."}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

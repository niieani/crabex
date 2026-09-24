import type { ModelRoute } from "../routing/model-routes.ts";
import { authorizationFor, responseTargetUrl } from "../routing/model-routes.ts";
import { applyRouteToolPolicy } from "../routing/tool-policy.ts";
import { preparePlaintextAgentMessages } from "./multi-agent-handoff.ts";
import { sanitizeMixedProviderHistory } from "./mixed-provider-history.ts";
import { NativeRoutedAgentsBridge, type RoutedAgentRegistry } from "./native-routed-agents.ts";
import { httpPayloadFor } from "./responses-bridge.ts";
import { createResponsesToolBridge, type ResponsesToolBridge } from "./responses-tool-bridge.ts";
import { brokerRouteFor, needsSearchBroker } from "./search-broker.ts";
import {
  prepareStoredRequest,
  storedResponseKey,
  type PreparedStoredRequest,
  type StoredResponseState,
  type StoredResponseRegistry,
} from "./stored-response-continuation.ts";
import type { LoadedToolRegistry } from "./tool-search.ts";

type Payload = Record<string, unknown>;

export interface RoutedRequestContext {
  route: ModelRoute;
  routes: readonly ModelRoute[];
  payload: Payload;
  search: string;
  sessionKey?: string;
  sourceFamily?: string;
  targetFamily?: string;
  plaintextHandoffEnabled?: boolean;
  routedAgents?: {
    registry: RoutedAgentRegistry;
    scope: string;
    callerPath?: string;
    instructions?: string;
  };
  defaultBrokerRoute?: string;
  localWarmup?: boolean;
  storedResponses: StoredResponseRegistry;
  fallbackStoredResponse?: StoredResponseState;
  loadedTools: LoadedToolRegistry;
}

interface Preflight {
  omittedTypes: string[];
  policyPayload: Payload;
  agentPayload: Payload;
}

export type RoutedRequestPreparation =
  | ({ kind: "warmup" } & Preflight)
  | ({
      kind: "ready";
      authorization: string;
      brokerRoute?: ModelRoute;
      translatedPayload: Payload;
      translated: boolean;
      toolBridge?: ResponsesToolBridge;
      routedAgents?: NativeRoutedAgentsBridge;
      storedRequest?: PreparedStoredRequest;
      responseStateKey?: string;
    } & Preflight)
  | {
      kind: "failed";
      phase: "policy" | "preflight" | "upstream" | "translation";
      error: unknown;
      omittedTypes: string[];
      policyPayload?: Payload;
      agentPayload?: Payload;
    };

/** Shared request preparation for routed HTTP and WebSocket-to-HTTP creates. */
export function prepareRoutedRequest(context: RoutedRequestContext): RoutedRequestPreparation {
  const { route, payload } = context;
  let policy: ReturnType<typeof applyRouteToolPolicy>;
  try {
    policy = applyRouteToolPolicy(route, payload);
  } catch (error) {
    return { kind: "failed", phase: "policy", error, omittedTypes: [] };
  }
  let agentPayload: Payload;
  try {
    const sanitized = sanitizeMixedProviderHistory(policy.payload, {
      target: route.api === "anthropic-messages" ? "anthropic" : "responses",
      sourceFamily: context.sourceFamily,
      targetFamily: context.targetFamily,
    });
    agentPayload =
      route.handoffClass === "plaintext"
        ? preparePlaintextAgentMessages(
            sanitized,
            route.model.slug,
            context.plaintextHandoffEnabled,
          )
        : sanitized;
  } catch (error) {
    return {
      kind: "failed",
      phase: "preflight",
      error,
      omittedTypes: policy.omittedTypes,
      policyPayload: policy.payload,
    };
  }
  const preflight = {
    omittedTypes: policy.omittedTypes,
    policyPayload: policy.payload,
    agentPayload,
  };
  if (context.localWarmup && payload.generate === false) return { kind: "warmup", ...preflight };

  let authorization: string;
  let brokerRoute: ModelRoute | undefined;
  try {
    authorization = authorizationFor(route, process.env);
    brokerRoute = needsSearchBroker(route, agentPayload.tools)
      ? brokerRouteFor(
          context.routes,
          route.searchBrokerRoute ?? context.defaultBrokerRoute ?? "gpt-6-luna",
          route.model.slug,
        )
      : undefined;
  } catch (error) {
    return { kind: "failed", phase: "upstream", error, ...preflight };
  }

  try {
    const forwardedPayload = httpPayloadFor(agentPayload, {
      forwardAccessPrograms: route.forwardAccessPrograms,
      storeResponses: route.bridgeResponseState === "stored",
    });
    const routedAgents =
      context.routedAgents &&
      route.api !== "anthropic-messages" &&
      route.handoffClass === "native-encrypted"
        ? new NativeRoutedAgentsBridge(
            context.routes
              .filter(
                (candidate) =>
                  candidate.enabled &&
                  candidate.transport === "http" &&
                  candidate.handoffClass === "plaintext",
              )
              .map((candidate) => ({
                slug: candidate.model.slug,
                ...(candidate.agentGuidance ? { guidance: candidate.agentGuidance } : {}),
              })),
            context.routedAgents.scope,
            context.routedAgents.registry,
            context.routedAgents.callerPath,
            context.routedAgents.instructions,
          )
        : undefined;
    const scopedKey = storedResponseKey(
      context.sessionKey,
      route.model.slug,
      responseTargetUrl(route, context.search).toString(),
      route.targets[0]?.upstreamModel ?? route.model.slug,
      authorization,
    );
    const responseStateKey = route.bridgeResponseState === "stored" ? scopedKey : undefined;
    const storedRequest =
      route.bridgeResponseState === "stored"
        ? prepareStoredRequest(
            forwardedPayload,
            route.model.slug,
            responseStateKey === undefined
              ? context.fallbackStoredResponse
              : context.storedResponses.get(responseStateKey),
          )
        : undefined;
    // Observe full Codex-visible history before a stored continuation trims it.
    const observedPayload = routedAgents?.request(forwardedPayload) ?? forwardedPayload;
    const requestPayload = storedRequest?.payload ?? forwardedPayload;
    const searchPayload =
      route.toolPolicy.tool_search === "translate"
        ? context.loadedTools.prepare(route.model.slug, scopedKey, forwardedPayload, requestPayload)
        : requestPayload;
    const routedPayload =
      searchPayload === forwardedPayload
        ? observedPayload
        : (routedAgents?.request(searchPayload) ?? searchPayload);
    const toolBridge = createResponsesToolBridge(route, routedPayload.tools);
    const translatedPayload = toolBridge?.request(routedPayload) ?? routedPayload;
    return {
      kind: "ready",
      ...preflight,
      authorization,
      ...(brokerRoute === undefined ? {} : { brokerRoute }),
      translatedPayload,
      translated:
        toolBridge !== undefined ||
        searchPayload !== requestPayload ||
        routedPayload !== searchPayload,
      ...(toolBridge === undefined ? {} : { toolBridge }),
      ...(routedAgents === undefined ? {} : { routedAgents }),
      ...(storedRequest === undefined ? {} : { storedRequest }),
      ...(responseStateKey === undefined ? {} : { responseStateKey }),
    };
  } catch (error) {
    return { kind: "failed", phase: "translation", error, ...preflight };
  }
}

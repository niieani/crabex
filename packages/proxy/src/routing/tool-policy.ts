export const TOOL_TYPES = ["function", "namespace", "custom", "web_search", "tool_search"] as const;

export type ToolType = (typeof TOOL_TYPES)[number];
export type ToolAction = "pass" | "translate" | "broker" | "reject";
export type ToolPolicy = Record<ToolType, ToolAction>;
export type ToolPolicyConfig = Partial<ToolPolicy>;
export type ToolPolicyApi = "responses" | "anthropic-messages";

export class ToolPolicyError extends Error {}

const RESPONSE_DEFAULTS: ToolPolicy = {
  function: "pass",
  namespace: "pass",
  custom: "pass",
  web_search: "pass",
  tool_search: "pass",
};
const ANTHROPIC_DEFAULTS: ToolPolicy = {
  function: "translate",
  namespace: "translate",
  custom: "translate",
  web_search: "reject",
  tool_search: "reject",
};

export function parseToolConfiguration(
  policyValue: unknown,
  legacyValue: unknown,
  api: ToolPolicyApi,
  source: string,
): { tool_policy?: ToolPolicyConfig; allowed_tool_types?: string[] } {
  if (policyValue !== undefined && legacyValue !== undefined) {
    throw new Error(`${source} cannot set both tool_policy and allowed_tool_types`);
  }
  let tool_policy: ToolPolicyConfig | undefined;
  if (policyValue !== undefined) {
    if (!isRecord(policyValue)) throw new Error(`${source}.tool_policy must be an object`);
    tool_policy = {};
    for (const [type, action] of Object.entries(policyValue)) {
      if (!isToolType(type)) {
        throw new Error(`${source}.tool_policy.${type} is not a supported tool type`);
      }
      if (!isToolAction(action)) {
        throw new Error(`${source}.tool_policy.${type} must be pass, translate, broker, or reject`);
      }
      assertImplemented(api, type, action, `${source}.tool_policy.${type}`);
      tool_policy[type] = action;
    }
  }
  let allowed_tool_types: string[] | undefined;
  if (legacyValue !== undefined) {
    if (
      !Array.isArray(legacyValue) ||
      legacyValue.some((type) => typeof type !== "string" || type.trim().length === 0) ||
      new Set(legacyValue).size !== legacyValue.length
    ) {
      throw new Error(`${source}.allowed_tool_types must be an array of unique non-empty strings`);
    }
    for (const type of legacyValue) {
      if (!isToolType(type)) {
        throw new Error(`${source}.allowed_tool_types contains unsupported tool type "${type}"`);
      }
      const defaultAction = defaultsFor(api)[type];
      if (defaultAction === "reject") {
        throw new Error(
          `${source}.allowed_tool_types cannot enable unsupported tool type "${type}"`,
        );
      }
    }
    allowed_tool_types = legacyValue;
  }
  return {
    ...(tool_policy === undefined ? {} : { tool_policy }),
    ...(allowed_tool_types === undefined ? {} : { allowed_tool_types }),
  };
}

export function effectiveToolPolicy(config: {
  api?: ToolPolicyApi;
  tool_policy?: ToolPolicyConfig;
  allowed_tool_types?: readonly string[];
}): ToolPolicy {
  const api = config.api ?? "responses";
  const validated = parseToolConfiguration(
    config.tool_policy,
    config.allowed_tool_types,
    api,
    "model route",
  );
  const defaults = defaultsFor(api);
  const allowed = validated.allowed_tool_types;
  if (allowed !== undefined) {
    return Object.fromEntries(
      TOOL_TYPES.map((type) => [type, allowed.includes(type) ? defaults[type] : "reject"]),
    ) as ToolPolicy;
  }
  return { ...defaults, ...validated.tool_policy };
}

export function assertRouteTools(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  payload: Record<string, unknown>,
): void {
  const declarations = payload.tools;
  if (declarations !== undefined) {
    if (!Array.isArray(declarations)) {
      throw new ToolPolicyError(`model route "${route.model.slug}" requires tools to be an array`);
    }
    for (const declaration of declarations) {
      assertDeclaration(route, declaration);
    }
  }
  const choice = payload.tool_choice;
  if (isRecord(choice) && isToolType(choice.type)) {
    assertToolTypeAllowed(route, choice.type);
  }
}

function assertDeclaration(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  declaration: unknown,
): void {
  const type = isRecord(declaration) ? declaration.type : undefined;
  assertToolTypeAllowed(route, type);
  if (type !== "namespace") return;
  const children = (declaration as Record<string, unknown>).tools;
  if (!Array.isArray(children)) {
    throw new ToolPolicyError(
      `model route "${route.model.slug}" requires namespace.tools to be an array`,
    );
  }
  for (const child of children) assertDeclaration(route, child);
}

function assertToolTypeAllowed(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  type: unknown,
): void {
  if (!isToolType(type)) {
    throw new ToolPolicyError(
      `model route "${route.model.slug}" received unknown tool type "${String(type)}"`,
    );
  }
  if (route.toolPolicy[type] === "reject") {
    throw new ToolPolicyError(`model route "${route.model.slug}" rejects tool type "${type}"`);
  }
}

function defaultsFor(api: ToolPolicyApi): ToolPolicy {
  return api === "anthropic-messages" ? ANTHROPIC_DEFAULTS : RESPONSE_DEFAULTS;
}

function assertImplemented(api: ToolPolicyApi, type: ToolType, action: ToolAction, source: string) {
  if (
    action === "reject" ||
    (api === "responses" && action === "pass") ||
    (api === "anthropic-messages" &&
      action === "translate" &&
      (type === "function" || type === "namespace" || type === "custom"))
  ) {
    return;
  }
  throw new Error(`${source} action "${action}" is not implemented for ${api} routes`);
}

function isToolType(value: unknown): value is ToolType {
  return typeof value === "string" && TOOL_TYPES.some((type) => type === value);
}

function isToolAction(value: unknown): value is ToolAction {
  return value === "pass" || value === "translate" || value === "broker" || value === "reject";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

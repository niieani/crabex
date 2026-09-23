export const TOOL_TYPES = ["function", "namespace", "custom", "web_search", "tool_search"] as const;

export type ToolType = (typeof TOOL_TYPES)[number];
export type ToolPolicyKey = ToolType | "other";
export type ToolAction = "pass" | "translate" | "broker" | "omit" | "reject";
export type ToolPolicy = Record<ToolPolicyKey, ToolAction>;
export type ToolPolicyConfig = Partial<ToolPolicy>;
export type ToolPolicyApi = "responses" | "anthropic-messages";

export class ToolPolicyError extends Error {}

const warnedOmissions = new Set<string>();

const RESPONSE_DEFAULTS: ToolPolicy = {
  function: "pass",
  namespace: "pass",
  custom: "pass",
  web_search: "pass",
  tool_search: "pass",
  other: "pass",
};
const ANTHROPIC_DEFAULTS: ToolPolicy = {
  function: "translate",
  namespace: "translate",
  custom: "translate",
  web_search: "reject",
  tool_search: "reject",
  other: "reject",
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
      if (!isToolPolicyKey(type)) {
        throw new Error(`${source}.tool_policy.${type} is not a supported tool type`);
      }
      if (!isToolAction(action)) {
        throw new Error(
          `${source}.tool_policy.${type} must be pass, translate, broker, omit, or reject`,
        );
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
    return {
      ...Object.fromEntries(
        TOOL_TYPES.map((type) => [type, allowed.includes(type) ? defaults[type] : "omit"]),
      ),
      other: "omit",
    } as ToolPolicy;
  }
  return { ...defaults, ...validated.tool_policy };
}

export function applyRouteToolPolicy(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; omittedTypes: string[] } {
  const omittedTypes: string[] = [];
  const declarations = payload.tools;
  let tools: unknown[] | undefined;
  if (declarations !== undefined) {
    if (!Array.isArray(declarations)) {
      throw new ToolPolicyError(`model route "${route.model.slug}" requires tools to be an array`);
    }
    tools = declarations
      .map((declaration) => applyDeclaration(route, declaration, omittedTypes))
      .filter((declaration) => declaration !== undefined);
  }
  const choice = payload.tool_choice;
  let omitChoice = false;
  if (isRecord(choice)) {
    const type = declarationType(route, choice);
    const action = actionFor(route.toolPolicy, type);
    if (action === "reject") reject(route, type);
    omitChoice = action === "omit";
    if (declarations !== undefined && tools !== undefined) {
      omitChoice ||= choiceMatches(choice, declarations) && !choiceMatches(choice, tools);
    }
    if (omitChoice) addOmission(omittedTypes, type);
  }
  if (omittedTypes.length === 0) return { payload, omittedTypes };
  const filtered = { ...payload };
  if (tools !== undefined) filtered.tools = tools;
  if (omitChoice) delete filtered.tool_choice;
  return { payload: filtered, omittedTypes };
}

export function warnOmittedToolTypes(routeSlug: string, omittedTypes: readonly string[]): void {
  for (const type of omittedTypes) {
    const key = JSON.stringify([routeSlug, type]);
    if (warnedOmissions.has(key)) continue;
    warnedOmissions.add(key);
    console.warn(`model route "${routeSlug}" omitted tool type "${type}"`);
  }
}

function applyDeclaration(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  declaration: unknown,
  omittedTypes: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(declaration)) {
    throw new ToolPolicyError(
      `model route "${route.model.slug}" received invalid tool declaration type`,
    );
  }
  const type = declarationType(route, declaration);
  const action = actionFor(route.toolPolicy, type);
  if (action === "reject") reject(route, type);
  if (action === "omit") {
    addOmission(omittedTypes, type);
    return undefined;
  }
  if (type !== "namespace") return declaration;
  const children = declaration.tools;
  if (!Array.isArray(children)) {
    throw new ToolPolicyError(
      `model route "${route.model.slug}" requires namespace.tools to be an array`,
    );
  }
  const retained = children
    .map((child) => applyDeclaration(route, child, omittedTypes))
    .filter((child) => child !== undefined);
  if (retained.length === children.length) return declaration;
  if (retained.length === 0) {
    addOmission(omittedTypes, "namespace");
    return undefined;
  }
  return { ...declaration, tools: retained };
}

function declarationType(
  route: { model: { slug: string }; toolPolicy: ToolPolicy },
  declaration: unknown,
): string {
  const type = isRecord(declaration) ? declaration.type : undefined;
  if (typeof type !== "string" || type.length === 0) {
    throw new ToolPolicyError(
      `model route "${route.model.slug}" received invalid tool declaration type`,
    );
  }
  return type;
}

function actionFor(policy: ToolPolicy, type: string): ToolAction {
  return isToolType(type) ? policy[type] : policy.other;
}

function reject(route: { model: { slug: string } }, type: string): never {
  throw new ToolPolicyError(`model route "${route.model.slug}" rejects tool type "${type}"`);
}

function addOmission(omittedTypes: string[], type: string): void {
  if (!omittedTypes.includes(type)) omittedTypes.push(type);
}

function choiceMatches(
  choice: Record<string, unknown>,
  declarations: readonly unknown[],
  namespace?: string,
): boolean {
  for (const declaration of declarations) {
    if (!isRecord(declaration)) continue;
    if (declaration.type === "namespace") {
      if (typeof declaration.name !== "string" || !Array.isArray(declaration.tools)) continue;
      if (choiceMatches(choice, declaration.tools, declaration.name)) return true;
      continue;
    }
    if (choice.type !== declaration.type) continue;
    if (choice.name !== undefined && choice.name !== declaration.name) continue;
    const choiceNamespace = choice.namespace === "functions" ? undefined : choice.namespace;
    if (choiceNamespace !== namespace) continue;
    return true;
  }
  return false;
}

function defaultsFor(api: ToolPolicyApi): ToolPolicy {
  return api === "anthropic-messages" ? ANTHROPIC_DEFAULTS : RESPONSE_DEFAULTS;
}

function assertImplemented(
  api: ToolPolicyApi,
  type: ToolPolicyKey,
  action: ToolAction,
  source: string,
) {
  if (
    action === "reject" ||
    action === "omit" ||
    (api === "responses" && action === "pass") ||
    (api === "responses" && type === "custom" && action === "translate") ||
    (type === "tool_search" && action === "translate") ||
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

function isToolPolicyKey(value: unknown): value is ToolPolicyKey {
  return value === "other" || isToolType(value);
}

function isToolAction(value: unknown): value is ToolAction {
  return (
    value === "pass" ||
    value === "translate" ||
    value === "broker" ||
    value === "omit" ||
    value === "reject"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

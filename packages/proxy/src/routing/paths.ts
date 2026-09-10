const CHATGPT_BACKEND_API_PATH = "/backend-api";
const CONFIG_BUNDLE_PATH = "/wham/config/bundle";
const CODEX_MODELS_PATH = "/codex/models";
const CODEX_RESPONSES_PATH = "/codex/responses";

export function isConfigBundleRequest(pathname: string): boolean {
  return (
    pathname === CONFIG_BUNDLE_PATH ||
    pathname === `${CHATGPT_BACKEND_API_PATH}${CONFIG_BUNDLE_PATH}`
  );
}

export function isModelsRequest(method: string, pathname: string): boolean {
  return (
    method === "GET" &&
    (pathname === CODEX_MODELS_PATH ||
      pathname === `${CHATGPT_BACKEND_API_PATH}${CODEX_MODELS_PATH}`)
  );
}

export function isResponsesPath(pathname: string): boolean {
  return (
    pathname === CODEX_RESPONSES_PATH ||
    pathname === `${CHATGPT_BACKEND_API_PATH}${CODEX_RESPONSES_PATH}`
  );
}

export function isResponsesRequest(method: string, pathname: string): boolean {
  return method === "POST" && isResponsesPath(pathname);
}

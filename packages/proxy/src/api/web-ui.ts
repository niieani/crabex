import { join, resolve, sep } from "node:path";

const PAGES = new Set([
  "/",
  "/transformations",
  "/routes",
  "/requests",
  "/config-bundle",
  "/setup",
]);

export async function findUiDirectory(cliDirectory: string): Promise<string | undefined> {
  for (const directory of [join(cliDirectory, "ui"), resolve(cliDirectory, "../../ui/dist")]) {
    if (await Bun.file(join(directory, "index.html")).exists()) return directory;
  }
  return undefined;
}

/** Only claim UI routes: all other paths retain their upstream proxy semantics. */
export function createWebUi(directory: string | undefined) {
  return async (request: Request): Promise<Response | undefined> => {
    const pathname = new URL(request.url).pathname;
    const page = PAGES.has(pathname);
    if (!page && !pathname.startsWith("/assets/") && pathname !== "/crabex.png") return undefined;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    if (!directory)
      return new Response(
        "Crabex UI has not been built. Run vp run build, then restart the proxy.",
        { status: 503 },
      );
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    const path = resolve(directory, page ? "index.html" : `.${decoded}`);
    if (!path.startsWith(resolve(directory) + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "content-type": file.type,
        "cache-control":
          page || pathname === "/crabex.png" ? "no-cache" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  };
}

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppShell } from "./app/AppShell.tsx";
import { CatalogPage } from "./pages/CatalogPage.tsx";
import { ConfigBundlePage } from "./pages/ConfigBundlePage.tsx";
import { ModelRoutesPage } from "./pages/ModelRoutesPage.tsx";
import { LiveRequestsPage } from "./pages/LiveRequestsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { TransformationsPage } from "./pages/TransformationsPage.tsx";

const rootRoute = createRootRoute({ component: AppShell });
const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: CatalogPage,
});
const transformationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transformations",
  component: TransformationsPage,
});
const modelRoutesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routes",
  component: ModelRoutesPage,
});
const liveRequestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/requests",
  component: LiveRequestsPage,
});
const configBundleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/config-bundle",
  component: ConfigBundlePage,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const routeTree = rootRoute.addChildren([
  catalogRoute,
  transformationsRoute,
  modelRoutesRoute,
  liveRequestsRoute,
  configBundleRoute,
  setupRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

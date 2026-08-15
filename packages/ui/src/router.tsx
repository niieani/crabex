import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppShell } from "./app/AppShell.tsx";
import { CatalogPage } from "./pages/CatalogPage.tsx";
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

const routeTree = rootRoute.addChildren([catalogRoute, transformationsRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

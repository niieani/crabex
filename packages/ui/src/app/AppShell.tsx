import { Link, Outlet } from "@tanstack/react-router";
import { Activity, ArrowRightLeft, Boxes, Cable, Layers3, SlidersHorizontal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getProxyConfig } from "../lib/api.ts";

const navigation = [
  { to: "/routes", label: "Model routes", icon: ArrowRightLeft },
  { to: "/", label: "Captures", icon: Layers3 },
  { to: "/requests", label: "Live traffic", icon: Activity },
  { to: "/transformations", label: "Transformations", icon: SlidersHorizontal },
  { to: "/config-bundle", label: "Advanced", icon: Boxes },
  { to: "/setup", label: "Connection", icon: Cable },
] as const;

export function AppShell() {
  const connection = useQuery({
    queryKey: ["proxy-config"],
    queryFn: getProxyConfig,
    refetchInterval: 15000,
  });
  return (
    <div className="app-shell">
      <aside className="app-navigation">
        <Link to="/" className="brand" aria-label="Crabex home">
          <img className="brand-mark" src="/crabex.svg" alt="" />
          <span className="brand-copy">
            <strong>Crabex</strong>
            <small>ANY MODEL, CODEX SHELL</small>
          </span>
        </Link>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              title={label}
              className="nav-link"
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="connection-status" role="status">
          <span className={`status-dot ${connection.isError ? "offline" : ""}`} />
          <div>
            <strong>
              {connection.isError
                ? "Proxy unavailable"
                : connection.isPending
                  ? "Connecting"
                  : "Proxy connected"}
            </strong>
            <small>{window.location.host}</small>
          </div>
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

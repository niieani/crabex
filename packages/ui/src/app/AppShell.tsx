import { Link, Outlet } from "@tanstack/react-router";
import {
  Activity,
  ArrowRightLeft,
  Boxes,
  Cable,
  Layers3,
  Radio,
  SlidersHorizontal,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getProxyConfig } from "../lib/api.ts";

const navigation = [
  { to: "/", label: "Captures", icon: Layers3 },
  { to: "/requests", label: "Live traffic", icon: Activity },
  { to: "/routes", label: "Model routes", icon: ArrowRightLeft },
  { to: "/transformations", label: "Transformations", icon: SlidersHorizontal },
  { to: "/config-bundle", label: "Configuration", icon: Boxes },
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
        <Link to="/" className="brand" aria-label="Relaydeck home">
          <span className="brand-mark">
            <Radio size={23} strokeWidth={1.8} />
          </span>
          <span className="brand-copy">
            <strong>Relaydeck</strong>
            <small>AGENT CONTROL ROOM</small>
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

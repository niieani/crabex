import { Link, Outlet } from "@tanstack/react-router";

export function AppShell() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-black text-canvas">
            CT
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">Agent Context Trimmer</p>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted">Inference input lab</p>
          </div>
        </div>
        <nav className="flex max-w-[70vw] items-center gap-1 overflow-x-auto rounded-lg border border-line bg-canvas p-1 text-xs">
          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Context catalog
          </Link>
          <Link
            to="/transformations"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Transformations
          </Link>
          <Link
            to="/routes"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Model routes
          </Link>
          <Link
            to="/requests"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Live requests
          </Link>
          <Link
            to="/config-bundle"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Config bundle
          </Link>
          <Link
            to="/setup"
            className="rounded-md px-3 py-1.5 text-muted transition hover:text-ink [&.active]:bg-panel-raised [&.active]:text-ink"
          >
            Codex setup
          </Link>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

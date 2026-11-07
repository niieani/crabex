// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getSharedLogin, issueClientKey, putSharedLogin, revokeClientKey } from "../../lib/api.ts";
import type { SharedLoginState } from "../../lib/types.ts";
import { SharedLoginCard } from "./SharedLoginCard.tsx";

vi.mock("../../lib/api.ts", () => ({
  getSharedLogin: vi.fn(),
  putSharedLogin: vi.fn(),
  issueClientKey: vi.fn(),
  revokeClientKey: vi.fn(),
}));

const off: SharedLoginState = {
  enabled: false,
  listen: "127.0.0.1:8766",
  running: false,
  tls: false,
  login: { state: "ready", path: "/home/me/.codex/auth.json", detail: "ChatGPT login available" },
  keys: [],
};

function renderCard() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SharedLoginCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getSharedLogin).mockResolvedValue(off);
  vi.mocked(putSharedLogin).mockImplementation(async (update) => ({ ...off, ...update }));
  vi.mocked(revokeClientKey).mockResolvedValue(off);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SharedLoginCard", () => {
  it("is off by default and turns on with one switch", async () => {
    renderCard();
    const toggle = await screen.findByRole("switch", { name: "Shared Login" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(vi.mocked(putSharedLogin).mock.calls[0]?.[0]).toEqual({ enabled: true }),
    );
  });

  it("switches listening to all interfaces and warns about plain HTTP", async () => {
    vi.mocked(getSharedLogin).mockResolvedValue({ ...off, enabled: true, running: true });
    renderCard();
    fireEvent.click(await screen.findByRole("radio", { name: "All interfaces" }));
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() =>
      expect(vi.mocked(putSharedLogin).mock.calls[0]?.[0]).toEqual({ listen: "0.0.0.0:8766" }),
    );
    expect(await screen.findByText(/plain HTTP/)).toBeTruthy();
  });

  it("accepts a specific address and port", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("radio", { name: "Specific address" }));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "192.0.2.10" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() =>
      expect(vi.mocked(putSharedLogin).mock.calls[0]?.[0]).toEqual({ listen: "192.0.2.10:9000" }),
    );
  });

  it("brackets an IPv6 address", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("radio", { name: "Specific address" }));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "fd00::5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() =>
      expect(vi.mocked(putSharedLogin).mock.calls[0]?.[0]).toEqual({ listen: "[fd00::5]:8766" }),
    );
  });

  it("shows a new key's secret once with client setup, and hides it on dismissal", async () => {
    vi.mocked(issueClientKey).mockResolvedValue({
      id: "1",
      name: "laptop",
      createdAt: "2030-01-01T00:00:00Z",
      secret: "crabex_secret",
    });
    vi.mocked(getSharedLogin).mockResolvedValue({
      ...off,
      enabled: true,
      running: true,
      listen: "192.0.2.10:8766",
      origin: "http://192.0.2.10:8766",
    });
    renderCard();
    fireEvent.change(await screen.findByLabelText("Key name"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate key" }));

    const setup = await screen.findByTestId("client-setup");
    expect(setup.textContent).toContain("crabex_secret");
    expect(setup.textContent).toContain('openai_base_url = "http://192.0.2.10:8766/v1"');
    expect(setup.textContent).toContain("codex login --with-api-key");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/crabex_secret/)).toBeNull();
  });

  it("uses a placeholder host when listening on all interfaces", async () => {
    vi.mocked(issueClientKey).mockResolvedValue({
      id: "1",
      name: "laptop",
      createdAt: "2030-01-01T00:00:00Z",
      secret: "crabex_secret",
    });
    vi.mocked(getSharedLogin).mockResolvedValue({ ...off, listen: "0.0.0.0:8766" });
    renderCard();
    fireEvent.change(await screen.findByLabelText("Key name"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate key" }));
    expect((await screen.findByTestId("client-setup")).textContent).toContain(
      "http://<this-host>:8766/v1",
    );
  });

  it("lists keys and revokes one after confirmation", async () => {
    vi.mocked(getSharedLogin).mockResolvedValue({
      ...off,
      keys: [{ id: "key-1", name: "laptop", createdAt: "2030-01-01T00:00:00Z" }],
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke laptop" }));
    expect(revokeClientKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke laptop" }));
    await waitFor(() => expect(vi.mocked(revokeClientKey).mock.calls[0]?.[0]).toBe("key-1"));
  });

  it("shows login problems and bind errors", async () => {
    vi.mocked(getSharedLogin).mockResolvedValue({
      ...off,
      enabled: true,
      error: "address in use",
      login: { state: "missing", path: "/x/auth.json", detail: "No Codex login found." },
    });
    renderCard();
    expect(await screen.findByText(/No Codex login found/)).toBeTruthy();
    expect(screen.getByText(/address in use/)).toBeTruthy();
  });

  it("locks settings fixed by the command line", async () => {
    vi.mocked(getSharedLogin).mockResolvedValue({
      ...off,
      enabled: true,
      enabledOverride: true,
      listenOverride: "127.0.0.1:9000",
      listen: "127.0.0.1:9000",
    });
    renderCard();
    const toggle = await screen.findByRole("switch", { name: "Shared Login" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save address" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

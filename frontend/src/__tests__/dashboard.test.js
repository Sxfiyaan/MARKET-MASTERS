import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import { api } from "../lib/api";
import * as auth from "../lib/auth";

describe("Dashboard Automatic Recovery & Synchronization", () => {
  let container;
  let root;
  let getSpy;
  let authSpy;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    authSpy = jest.spyOn(auth, "useAuth").mockReturnValue({
      user: {
        id: "test-user-1",
        email: "team@test.com",
        role: "team",
        team: { id: "team-1", team_name: "Desk Alpha", college: "Finance Academy" },
      },
      logout: jest.fn(),
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    if (container) {
      container.remove();
    }
    if (getSpy) getSpy.mockRestore();
    if (authSpy) authSpy.mockRestore();
  });

  test("automatically updates from COMPLETED to Enter Waiting Room upon reset refresh", async () => {
    let r1State = "COMPLETED";

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            rounds: {
              "1": { state: r1State },
              "2": { state: "UPCOMING" },
              "3": { state: "UPCOMING" },
            },
          },
        });
      }
      if (url === "/scores/me") {
        return Promise.resolve({
          data: { rank: 1, total: r1State === "COMPLETED" ? 250 : 0, risk_score: 500 },
        });
      }
      if (url === "/announcements") {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: {} });
    });

    // Mount Dashboard when Round 1 was COMPLETED
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Initial state is COMPLETED with View Summary CTA
    expect(container.textContent).toContain("View Summary");
    expect(container.textContent).toContain("COMPLETED");

    // Admin resets gameplay: backend config now returns UPCOMING and 0 scores
    r1State = "UPCOMING";

    // Simulate window focus event triggering auto-recovery without manual page refresh
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // Dashboard automatically recovered to WAITING / UPCOMING without requiring manual browser reload
    expect(container.textContent).toContain("Enter Waiting Room");
    expect(container.textContent).not.toContain("View Summary");
  });

  test("triggers immediate background refresh on tab visibility change", async () => {
    let callCount = 0;
    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        callCount++;
        return Promise.resolve({
          data: { rounds: { "1": { state: "UPCOMING" } } },
        });
      }
      if (url === "/scores/me") return Promise.resolve({ data: { rank: 1, total: 0 } });
      if (url === "/announcements") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const initialCalls = callCount;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Simulate tab becoming visible after being in background
    Object.defineProperty(document, "visibilityState", { value: "visible", writable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(callCount).toBeGreaterThan(initialCalls);
  });

  test("coalesces simultaneous focus and visibilitychange events into a single API request batch", async () => {
    let configFetches = 0;
    let resolveInFlight;

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        configFetches++;
        return new Promise((res) => {
          resolveInFlight = res;
        });
      }
      if (url === "/scores/me") return Promise.resolve({ data: { rank: 1, total: 100 } });
      if (url === "/announcements") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      );
    });

    // Mount started the initial request (configFetches === 1), which is currently unresolved
    expect(configFetches).toBe(1);

    // Fire focus AND visibilitychange simultaneously while the initial request is in-flight
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Both simultaneous events must be coalesced without firing duplicate network requests!
    expect(configFetches).toBe(1);

    // Resolve in-flight request
    await act(async () => {
      resolveInFlight({ data: { rounds: { "1": { state: "UPCOMING" } } } });
      await Promise.resolve();
    });

    expect(configFetches).toBe(1);
  });

  test("enables Enter Waiting Room for Round 2 when UPCOMING", async () => {
    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            rounds: {
              "1": { state: "COMPLETED" },
              "2": { state: "UPCOMING" },
              "3": { state: "UPCOMING" },
            },
          },
        });
      }
      if (url === "/scores/me") return Promise.resolve({ data: { rank: 1, total: 100 } });
      if (url === "/announcements") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      );
    });

    const r2EnterBtn = container.querySelector('[data-testid="dashboard-round-2-enter"]');
    expect(r2EnterBtn).not.toBeNull();
    expect(r2EnterBtn.textContent).toBe("Enter Waiting Room");
    expect(r2EnterBtn.getAttribute("href")).toBe("/round2");
  });

  test("displays 'View Final Standings' button linking to /results when results_finalized and leaderboard_visible, updating via live-refresh without manual reload", async () => {
    let resultsFinalized = false;
    let leaderboardVisible = true;

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            results_finalized: resultsFinalized,
            leaderboard_visible: leaderboardVisible,
            rounds: {
              "1": { state: "COMPLETED" },
              "2": { state: "COMPLETED" },
              "3": { state: "COMPLETED" },
            },
          },
        });
      }
      if (url === "/scores/me") return Promise.resolve({ data: { rank: 1, total: 500, risk_score: 500 } });
      if (url === "/announcements") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      );
    });

    // Initially unfinalized: no View Final Standings button
    expect(container.querySelector('[data-testid="view-final-standings-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="final-standings-callout"]')).toBeNull();

    // Admin finalizes results: backend now returns results_finalized: true
    resultsFinalized = true;

    // Simulate focus/live-refresh without manual page reload
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // Button appears automatically on live refresh
    const standingsBtn = container.querySelector('[data-testid="view-final-standings-btn"]');
    expect(standingsBtn).not.toBeNull();
    expect(standingsBtn.textContent).toContain("View Final Standings");
    expect(standingsBtn.getAttribute("href")).toBe("/results");

    const callout = container.querySelector('[data-testid="final-standings-callout"]');
    expect(callout).not.toBeNull();
    expect(callout.textContent).toContain("The Market Has Spoken.");

    // If organizer hides leaderboard, button disappears
    leaderboardVisible = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="view-final-standings-btn"]')).toBeNull();
  });
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import Register from "../pages/Register";
import Results from "../pages/Result";
import { api } from "../lib/api";
import * as auth from "../lib/auth";

describe("Register & Results Requirements", () => {
  let container;
  let root;
  let getSpy;
  let authSpy;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    authSpy = jest.spyOn(auth, "useAuth").mockReturnValue({
      user: null,
      logout: jest.fn(),
      register: jest.fn().mockResolvedValue({ ok: true }),
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

  test("Register component configures 10-digit phone with numeric keyboard and field-level validation", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Register />
        </MemoryRouter>
      );
    });

    const phoneInput = container.querySelector('[data-testid="input-leader-phone"]');
    expect(phoneInput).toBeTruthy();
    expect(phoneInput.getAttribute("type")).toBe("tel");
    expect(phoneInput.getAttribute("inputmode")).toBe("numeric");
    expect(phoneInput.getAttribute("maxlength")).toBe("10");

    // Simulate input with letters and punctuation
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;

    await act(async () => {
      nativeInputValueSetter.call(phoneInput, "098-abc-123");
      phoneInput.dispatchEvent(new Event("input", { bubbles: true }));
      phoneInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Cleaned state reflected in input
    expect(phoneInput.value).toBe("098123");

    // Check field-level error message when < 10 digits
    const errorEl = container.querySelector('[data-testid="input-leader-phone-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toBe("Phone number must be exactly 10 digits");

    // Complete to 10 digits with leading zero
    await act(async () => {
      nativeInputValueSetter.call(phoneInput, "0987654321");
      phoneInput.dispatchEvent(new Event("input", { bubbles: true }));
      phoneInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(phoneInput.value).toBe("0987654321");
    expect(container.querySelector('[data-testid="input-leader-phone-error"]')).toBeNull();
  });

  test("Results page displays 'Current Standings' while R1 or R3 complete, and switches to 'Final Ceremony' only on explicit finalization", async () => {
    let r3State = "UPCOMING";
    let resultsFinalized = false;

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            results_finalized: resultsFinalized,
            rounds: {
              "1": { state: "COMPLETED" },
              "2": { state: "UPCOMING" },
              "3": { state: r3State },
            },
          },
        });
      }
      if (url === "/leaderboard") {
        return Promise.resolve({
          data: {
            visible: true,
            rows: [
              { team_id: "t1", team_name: "Alpha", college: "Univ A", round1: 100, round2: 0, round3: 0, risk_score: 500, total: 30, rank: 1 },
            ],
          },
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Results />
        </MemoryRouter>
      );
    });

    // (1) R1 completed, R3 upcoming, unfinalized:
    const titleEl = container.querySelector('[data-testid="results-title"]');
    const badgeEl = container.querySelector('[data-testid="results-badge"]');
    expect(titleEl.textContent).toBe("Current Standings");
    expect(badgeEl.textContent).toContain("CURRENT STANDINGS");

    // (2) Round 3 completed alone (e.g. Stop Event or gameplay completed): must NOT finalize results
    r3State = "COMPLETED";
    resultsFinalized = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(titleEl.textContent).toBe("Current Standings");
    expect(badgeEl.textContent).toContain("CURRENT STANDINGS");

    // (3) Explicit Admin Finalization: results_finalized = true
    resultsFinalized = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(titleEl.textContent).toBe("THE MARKET HAS SPOKEN.");
    expect(badgeEl.textContent).toContain("FINAL CEREMONY");

    // (4) Reset Gameplay: results_finalized cleared back to false
    resultsFinalized = false;
    r3State = "UPCOMING";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(titleEl.textContent).toBe("Current Standings");
    expect(badgeEl.textContent).toContain("CURRENT STANDINGS");
  });

  test("Results displays all teams (>10) without truncation, highlights signed-in team, and enforces responsive table", async () => {
    // Isolated fixture with 15 teams
    const mockTeams = Array.from({ length: 15 }, (_, i) => ({
      team_id: `team-${i + 1}`,
      team_name: `Team ${String.fromCharCode(65 + i)}`,
      college: `Institute ${i + 1}`,
      round1: 80 + i,
      round2: 5 + i,
      round3: 600 + i * 10,
      risk_score: 500,
      total: 300 + i * 15,
      rank: i + 1,
    }));

    // Signed-in as team-7
    authSpy.mockReturnValue({
      user: {
        id: "user-7",
        team_id: "team-7",
        role: "team",
        team: { id: "team-7", team_name: "Team G", college: "Institute 7" },
      },
      logout: jest.fn(),
    });

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            results_finalized: true,
            leaderboard_visible: true,
            rounds: {
              "1": { state: "COMPLETED" },
              "2": { state: "COMPLETED" },
              "3": { state: "COMPLETED" },
            },
          },
        });
      }
      if (url === "/leaderboard") {
        return Promise.resolve({
          data: {
            visible: true,
            rows: mockTeams,
          },
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Results />
        </MemoryRouter>
      );
    });

    // Check all 15 teams are rendered - NO top-10 truncation!
    const rowElements = container.querySelectorAll('[data-testid^="standings-row-"]');
    expect(rowElements.length).toBe(15);

    // Verify ranks 1 through 15 are all present in order
    for (let i = 1; i <= 15; i++) {
      const row = container.querySelector(`[data-testid="standings-row-${i}"]`);
      expect(row).toBeTruthy();
      expect(row.textContent).toContain(`#${i}`);
    }

    // Verify signed-in team (team-7, rank 7) is clearly highlighted
    const team7Row = container.querySelector('[data-testid="standings-row-7"]');
    expect(team7Row).toBeTruthy();
    expect(team7Row.getAttribute("data-is-user-team")).toBe("true");
    expect(team7Row.className).toContain("bg-mm-gold/15");
    expect(team7Row.className).toContain("border-l-4 border-l-mm-gold");

    const badge = team7Row.querySelector('[data-testid="user-team-badge"]');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("YOUR TEAM");

    // Other rows should NOT have user-team badge or attribute
    const team1Row = container.querySelector('[data-testid="standings-row-1"]');
    expect(team1Row.getAttribute("data-is-user-team")).toBeNull();
    expect(team1Row.querySelector('[data-testid="user-team-badge"]')).toBeNull();

    // Responsive table verification
    const tableContainer = container.querySelector('[data-testid="results-table-container"]');
    expect(tableContainer).toBeTruthy();
    expect(tableContainer.className).toContain("overflow-x-auto");

    const table = container.querySelector('[data-testid="final-standings-table"]');
    expect(table).toBeTruthy();
    expect(table.className).toContain("min-w-[640px]");
  });

  test("Results enforces server-side visibility restriction when leaderboard_visible is false", async () => {
    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/event/config") {
        return Promise.resolve({
          data: {
            results_finalized: true,
            leaderboard_visible: false,
          },
        });
      }
      if (url === "/leaderboard") {
        return Promise.resolve({
          data: {
            visible: false,
            rows: [],
          },
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Results />
        </MemoryRouter>
      );
    });

    // Hidden message shown
    const hiddenEl = container.querySelector('[data-testid="results-hidden-message"]');
    expect(hiddenEl).toBeTruthy();
    expect(hiddenEl.textContent).toContain("STANDINGS RESTRICTED");
    expect(hiddenEl.textContent).toContain("Final standings are not visible yet.");

    // Table and podium are NOT rendered
    expect(container.querySelector('[data-testid="final-standings-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="podium-1"]')).toBeNull();
  });
});

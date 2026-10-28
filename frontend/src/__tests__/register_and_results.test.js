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
});

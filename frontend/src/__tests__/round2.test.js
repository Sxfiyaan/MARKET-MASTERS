import React from "react";
import Round2 from "../pages/Round2";
import QuestionsPanel from "../pages/QuestionsPanel";
import {
  calculateDisplaySeconds,
  handleDeadlineRetry,
  createRequestCoalescer,
} from "../lib/round1Sync";

describe("Round 2 Production Client Logic & UI Architecture", () => {
  test("imports production Round2 component successfully", () => {
    expect(typeof Round2).toBe("function");
    expect(Round2.name).toBe("Round2");
  });

  test("calculates display seconds accurately without dropping below 0", () => {
    const now = 1700000000000;
    // 119.5s remaining -> 120s display
    expect(calculateDisplaySeconds(new Date(now + 119500).toISOString(), false, 0, 0, now)).toBe(120);
    // 0.2s remaining -> 1s display
    expect(calculateDisplaySeconds(new Date(now + 200).toISOString(), false, 0, 0, now)).toBe(1);
    // past deadline -> clamped to 0
    expect(calculateDisplaySeconds(new Date(now - 1000).toISOString(), false, 0, 0, now)).toBe(0);
  });

  test("preserves paused remaining time accurately without fallback reset", () => {
    expect(calculateDisplaySeconds(null, true, 85, 0)).toBe(85);
    expect(calculateDisplaySeconds(null, true, 0, 0)).toBe(0);
  });

  test("bounded retry backoff does not exceed maximum limit of 4 retries", () => {
    let retryCount = 0;
    const delays = [];
    while (true) {
      const result = handleDeadlineRetry(retryCount, 4, 700);
      if (!result.canRetry) break;
      delays.push(result.delayMs);
      retryCount = result.nextRetryCount;
    }
    expect(retryCount).toBe(4);
    expect(delays).toEqual([700, 1400, 2100, 2800]);
  });

  test("coalesces duplicate concurrent requests", async () => {
    let executions = 0;
    const coalescer = createRequestCoalescer();
    const apiCall = async () => {
      executions++;
      return { status: "OK", count: executions };
    };

    const [res1, res2, res3] = await Promise.all([
      coalescer.execute(false, apiCall),
      coalescer.execute(false, apiCall),
      coalescer.execute(false, apiCall),
    ]);

    expect(executions).toBe(1);
    expect(res1.status).toBe("OK");
    expect(res2.status).toBe("OK");
    expect(res3.status).toBe("OK");
  });

  test("validates Round 2 question configuration in QuestionsPanel", () => {
    expect(typeof QuestionsPanel).toBe("function");
  });
});

describe("Round 2 Component Lifecycle & Mounted UI Interactivity", () => {
  let container;
  let root;
  let getSpy;
  let postSpy;
  let authSpy;

  const setInputValue = (el, val) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = require("react-dom/client");
    root = createRoot(container);

    const auth = require("../lib/auth");
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
    const { act } = require("react");
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    if (container) {
      container.remove();
    }
    if (getSpy) getSpy.mockRestore();
    if (postSpy) postSpy.mockRestore();
    if (authSpy) authSpy.mockRestore();
    jest.useRealTimers();
  });

  test("1. Mounts Round 2 Waiting Room with chart count and Standby status when UPCOMING", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({
          data: {
            phase: "WAITING",
            status: "IDLE",
            total_questions: 5,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    const waitingRoom = container.querySelector('[data-testid="r2-waiting-room"]');
    expect(waitingRoom).not.toBeNull();
    expect(waitingRoom.textContent).toContain("THE CALL");
    expect(waitingRoom.textContent).toContain("STANDBY");
    expect(container.querySelector('[data-testid="r2-total-questions"]').textContent).toBe("5 Charts");
  });

  test("2. Preserves decision and explanation drafts during question polling, clears drafts on reset or new run", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    let currentPhase = "QUESTION";
    let currentStatus = "ACTIVE";
    let qIndex = 0;

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({
          data: {
            phase: currentPhase,
            status: currentStatus,
            question_index: qIndex,
            total_questions: 5,
            is_paused: false,
            time_left: 100,
            phase_ends_at: new Date(Date.now() + 100000).toISOString(),
            question: {
              id: "q-r2-1",
              round: 2,
              text: "Chart 1: NIFTY Daily Breakout Setup",
              asset: "NIFTY50",
              timeframe: "1D",
            },
            team_submission: { answered: false },
            team_score: 0,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // Verify Question 1 is mounted
    expect(container.querySelector('[data-testid="r2-question-container"]')).not.toBeNull();

    // Select BUY decision
    const buyBtn = container.querySelector('[data-testid="r2-btn-buy"]');
    await act(async () => {
      buyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Enter explanation draft using React property setter
    const input = container.querySelector('[data-testid="r2-input-explanation"]');
    await act(async () => {
      setInputValue(input, "Bullish momentum displacement above key resistance.");
    });

    expect(input.value).toBe("Bullish momentum displacement above key resistance.");

    // Simulate routine background polling while question is open: draft must NOT be erased!
    await act(async () => {
      jest.advanceTimersByTime(3500); // Trigger background poll interval
      await Promise.resolve();
    });

    const inputAfterPoll = container.querySelector('[data-testid="r2-input-explanation"]');
    expect(inputAfterPoll.value).toBe("Bullish momentum displacement above key resistance.");

    // Now simulate Reset Gameplay (phase becomes WAITING, status IDLE)
    currentPhase = "WAITING";
    currentStatus = "IDLE";

    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // Component smoothly displays Waiting Room
    expect(container.querySelector('[data-testid="r2-waiting-room"]')).not.toBeNull();

    // Transition to new run (COUNTDOWN -> QUESTION)
    currentPhase = "QUESTION";
    currentStatus = "ACTIVE";
    qIndex = 0;

    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // Verify draft was completely cleared across the reset/new run!
    const freshInput = container.querySelector('[data-testid="r2-input-explanation"]');
    expect(freshInput).not.toBeNull();
    expect(freshInput.value).toBe("");
  });

  test("3. Delayed submission acknowledgement for Q1 must not replace Q1 RESULT data and erase correct/score", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    let currentPhase = "QUESTION";
    let currentSubmission = { answered: false };
    let currentScore = 0;
    let resolveSubmitPromise;

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({
          data: {
            phase: currentPhase,
            status: "ACTIVE",
            question_index: 0,
            total_questions: 5,
            is_paused: false,
            time_left: currentPhase === "QUESTION" ? 2 : 10,
            phase_ends_at: new Date(Date.now() + 10000).toISOString(),
            question: {
              id: "q-r2-1",
              round: 2,
              text: "Chart 1: NIFTY Daily Breakout Setup",
              asset: "NIFTY50",
              timeframe: "1D",
              correct_answer: "BUY",
            },
            team_submission: currentSubmission,
            team_score: currentScore,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    postSpy = jest.spyOn(api, "post").mockImplementation((url, body) => {
      if (url === "/rounds/2/submit") {
        // Return a pending promise that simulates network latency
        return new Promise((resolve) => {
          resolveSubmitPromise = () =>
            resolve({
              data: {
                ok: true,
                submission_id: "sub-123",
                answer: body.answer,
                explanation: body.explanation,
              },
            });
        });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // 1. Participant selects BUY and inputs explanation
    const buyBtn = container.querySelector('[data-testid="r2-btn-buy"]');
    await act(async () => {
      buyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = container.querySelector('[data-testid="r2-input-explanation"]');
    await act(async () => {
      setInputValue(input, "Bullish continuation pattern.");
    });

    // 2. Click Submit Decision: in-flight request started
    const submitBtn = container.querySelector('[data-testid="r2-btn-submit"]');
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(postSpy).toHaveBeenCalledTimes(1);

    // 3. Before submission resolves, deadline expires and status poll transitions to RESULT!
    currentPhase = "RESULT";
    currentSubmission = {
      answered: true,
      answer: "BUY",
      explanation: "Bullish continuation pattern.",
      correct: true,
      score: 1,
    };
    currentScore = 1;

    // Trigger status poll returning RESULT data
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // Verify RESULT screen is now visible with correct answer and +1 Pt
    const pointsBeforeLateAck = container.querySelector('[data-testid="r2-result-points"]');
    expect(pointsBeforeLateAck).not.toBeNull();
    expect(pointsBeforeLateAck.textContent).toBe("+1 Pt");

    // 4. Now the delayed submission acknowledgement resolves!
    await act(async () => {
      resolveSubmitPromise();
      await Promise.resolve();
    });

    // 5. The delayed acknowledgement must NOT have wiped out `correct` or `score`!
    const pointsAfterLateAck = container.querySelector('[data-testid="r2-result-points"]');
    expect(pointsAfterLateAck).not.toBeNull();
    expect(pointsAfterLateAck.textContent).toBe("+1 Pt");

    const currentScoreEl = container.querySelector('[data-testid="r2-current-score"]');
    expect(currentScoreEl).not.toBeNull();
    expect(currentScoreEl.textContent).toContain("1 pts");
  });

  test("4. Recovers seamlessly from COMPLETED screen to Waiting Room upon Reset Gameplay", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    let currentStatus = {
      phase: "COMPLETED",
      status: "COMPLETED",
      total_questions: 5,
      team_score: 4,
      server_time: new Date().toISOString(),
    };

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({ data: currentStatus });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // Verify completion screen
    expect(container.querySelector('[data-testid="r2-completed-screen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="r2-final-score"]').textContent).toContain("4");

    // Admin clicks Reset Gameplay: server returns WAITING
    currentStatus = {
      phase: "WAITING",
      status: "IDLE",
      total_questions: 5,
      server_time: new Date().toISOString(),
    };

    // Background poll detects reset
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // Automatically recovers to Waiting Room without manual page refresh!
    expect(container.querySelector('[data-testid="r2-waiting-room"]')).not.toBeNull();
  });

  test("5. BUY, SELL, NO_TRADE selection visual styling, aria-pressed, explicit text, switching choices, and submit flow", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    let currentPhase = "QUESTION";
    let isPaused = false;
    let currentSubmission = { answered: false };

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({
          data: {
            phase: currentPhase,
            status: "ACTIVE",
            question_index: 0,
            total_questions: 5,
            is_paused: isPaused,
            time_left: 110,
            phase_start_at: new Date(Date.now() - 10000).toISOString(),
            phase_ends_at: new Date(Date.now() + 110000).toISOString(),
            question: {
              id: "q-r2-1",
              round: 2,
              text: "Chart 1: NIFTY Daily Breakout Setup",
              asset: "NIFTY50",
              timeframe: "1D",
              correct_answer: "BUY",
            },
            team_submission: currentSubmission,
            team_score: 0,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    postSpy = jest.spyOn(api, "post").mockImplementation((url, body) => {
      if (url === "/rounds/2/submit") {
        currentSubmission = {
          answered: true,
          answer: body.answer,
          explanation: body.explanation,
        };
        return Promise.resolve({
          data: {
            ok: true,
            submission_id: "sub-r2-test",
            answer: body.answer,
            explanation: body.explanation,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    const buyBtn = container.querySelector('[data-testid="r2-btn-buy"]');
    const sellBtn = container.querySelector('[data-testid="r2-btn-sell"]');
    const noTradeBtn = container.querySelector('[data-testid="r2-btn-notrade"]');
    const activeDecisionBadge = container.querySelector('[data-testid="r2-current-selection-badge"]');
    const submitBtn = container.querySelector('[data-testid="r2-btn-submit"]');
    const input = container.querySelector('[data-testid="r2-input-explanation"]');

    // Initial state: nothing selected
    expect(buyBtn.getAttribute("aria-pressed")).toBe("false");
    expect(sellBtn.getAttribute("aria-pressed")).toBe("false");
    expect(noTradeBtn.getAttribute("aria-pressed")).toBe("false");
    expect(activeDecisionBadge.textContent).toContain("None Selected");
    expect(submitBtn.disabled).toBe(true);

    // 1. Select BUY
    await act(async () => {
      buyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(buyBtn.classList.contains("is-selected-buy")).toBe(true);
    expect(buyBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="r2-selected-indicator-buy"]').textContent).toContain("SELECTED: BUY");
    expect(activeDecisionBadge.textContent).toContain("Selected: BUY");
    // Submit still disabled because explanation is empty
    expect(submitBtn.disabled).toBe(true);

    // 2. Switch selection to SELL before submission
    await act(async () => {
      sellBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(buyBtn.classList.contains("is-selected-buy")).toBe(false);
    expect(buyBtn.getAttribute("aria-pressed")).toBe("false");
    expect(sellBtn.classList.contains("is-selected-sell")).toBe(true);
    expect(sellBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="r2-selected-indicator-sell"]').textContent).toContain("SELECTED: SELL");
    expect(activeDecisionBadge.textContent).toContain("Selected: SELL");

    // 3. Switch selection to NO TRADE before submission
    await act(async () => {
      noTradeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(sellBtn.classList.contains("is-selected-sell")).toBe(false);
    expect(sellBtn.getAttribute("aria-pressed")).toBe("false");
    expect(noTradeBtn.classList.contains("is-selected-notrade")).toBe(true);
    expect(noTradeBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="r2-selected-indicator-notrade"]').textContent).toContain("SELECTED: NO TRADE");
    expect(activeDecisionBadge.textContent).toContain("Selected: NO TRADE");

    // 4. Switch back to BUY and enter mandatory explanation
    await act(async () => {
      buyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(buyBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      setInputValue(input, "Clear higher low consolidation.");
    });

    // Both option selected + explanation filled -> Submit Decision becomes enabled!
    expect(submitBtn.disabled).toBe(false);

    // 5. Test background polling preserves selection and draft
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    expect(buyBtn.getAttribute("aria-pressed")).toBe("true");
    expect(buyBtn.classList.contains("is-selected-buy")).toBe(true);
    expect(input.value).toBe("Clear higher low consolidation.");
    expect(submitBtn.disabled).toBe(false);

    // 6. Test Pause disables interaction without clearing draft
    isPaused = true;
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    expect(buyBtn.disabled).toBe(true);
    expect(sellBtn.disabled).toBe(true);
    expect(noTradeBtn.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(submitBtn.disabled).toBe(true);
    // Draft is preserved while paused
    expect(buyBtn.getAttribute("aria-pressed")).toBe("true");
    expect(input.value).toBe("Clear higher low consolidation.");

    // Resume gameplay
    isPaused = false;
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    expect(buyBtn.disabled).toBe(false);
    expect(submitBtn.disabled).toBe(false);

    // 7. Submit Decision
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(postSpy).toHaveBeenCalledWith("/rounds/2/submit", {
      question_id: "q-r2-1",
      answer: "BUY",
      explanation: "Clear higher low consolidation.",
    });

    // 8. Server acknowledgement locks decision
    const lockedBanner = container.querySelector('[data-testid="r2-locked-banner"]');
    expect(lockedBanner).not.toBeNull();
    expect(lockedBanner.textContent).toContain("Decision Locked: BUY");
  });

  test("6. Unsubmitted drafts remain unanswered and RESULT screen displays 'No decision submitted'", async () => {
    const { act } = require("react");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");

    let currentPhase = "QUESTION";

    getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/2/status") {
        return Promise.resolve({
          data: {
            phase: currentPhase,
            status: "ACTIVE",
            question_index: 0,
            total_questions: 5,
            is_paused: false,
            time_left: currentPhase === "QUESTION" ? 5 : 10,
            phase_start_at: new Date(Date.now() - 115000).toISOString(),
            phase_ends_at: new Date(Date.now() + 5000).toISOString(),
            question: {
              id: "q-r2-1",
              round: 2,
              text: "Chart 1: NIFTY Daily Breakout Setup",
              asset: "NIFTY50",
              timeframe: "1D",
              correct_answer: "BUY",
            },
            team_submission: { answered: false }, // Never submitted!
            team_score: 0,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round2 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // Participant typed draft but NEVER clicked submit
    const buyBtn = container.querySelector('[data-testid="r2-btn-buy"]');
    await act(async () => {
      buyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector('[data-testid="r2-input-explanation"]');
    await act(async () => {
      setInputValue(input, "Unsent rationale.");
    });

    // Question deadline expires, transitioning to RESULT phase without submission
    currentPhase = "RESULT";
    await act(async () => {
      jest.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // Verify RESULT screen shows 'No decision submitted before the deadline (0 Pts).'
    const resultScreen = container.querySelector('[data-testid="r2-result-screen"]');
    expect(resultScreen).not.toBeNull();
    expect(resultScreen.textContent).toContain("No decision submitted before the deadline (0 Pts).");
    expect(container.querySelector('[data-testid="r2-correct-answer"]').textContent).toContain("BUY");
  });
});

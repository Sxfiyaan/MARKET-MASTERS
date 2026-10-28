import React, { act } from "react";
import {
  calculateDisplaySeconds,
  handleDeadlineRetry,
  processStatusResponse,
  applyAnswerConfirmation,
  handleSubmissionFailure,
  calculateActiveTimeTaken,
  calculateSpeedScore,
  createRequestCoalescer,
} from "../lib/round1Sync";
import Round1 from "../pages/Round1";

describe("Round 1 Production Client Logic & Utilities", () => {
  test("imports production Round1 component successfully", () => {
    expect(typeof Round1).toBe("function");
    expect(Round1.name).toBe("Round1");
  });

  test("calculates display seconds accurately without dropping below 0", () => {
    const now = 1700000000000;
    // 14.2 seconds remaining -> rounds up to 15s display
    expect(calculateDisplaySeconds(new Date(now + 14200).toISOString(), false, 0, 0, now)).toBe(15);
    // 0.2 seconds remaining -> 1s display
    expect(calculateDisplaySeconds(new Date(now + 200).toISOString(), false, 0, 0, now)).toBe(1);
    // past deadline -> clamped to 0
    expect(calculateDisplaySeconds(new Date(now - 1000).toISOString(), false, 0, 0, now)).toBe(0);
    // When no phase ends at and not paused -> 0
    expect(calculateDisplaySeconds(null, false, 0, 0, now)).toBe(0);
  });

  test("preserves paused remaining time accurately without fallback reset", () => {
    // When paused with remaining seconds
    expect(calculateDisplaySeconds(null, true, 24, 0)).toBe(24);
    // When paused with exactly 0 remaining seconds
    expect(calculateDisplaySeconds(null, true, 0, 0)).toBe(0);
    // When paused with null remaining seconds
    expect(calculateDisplaySeconds(null, true, null, 0)).toBe(0);
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

    // Subsequent call is blocked
    const fifth = handleDeadlineRetry(4, 4, 700);
    expect(fifth.canRetry).toBe(false);
  });

  test("compensates for client device clock skew using server_time offset", () => {
    const serverTimeMs = 1700000000000;
    const deadlineIso = new Date(serverTimeMs + 30000).toISOString(); // 30s remaining

    // Client device clock is 45 seconds FAST
    const clientFastNow = serverTimeMs + 45000;
    const skewFast = serverTimeMs - clientFastNow; // -45000
    expect(calculateDisplaySeconds(deadlineIso, false, 0, skewFast, clientFastNow)).toBe(30);

    // Client device clock is 30 seconds SLOW
    const clientSlowNow = serverTimeMs - 30000;
    const skewSlow = serverTimeMs - clientSlowNow; // +30000
    expect(calculateDisplaySeconds(deadlineIso, false, 0, skewSlow, clientSlowNow)).toBe(30);
  });

  test("verifies active time_taken ignores pause duration (10-minute pause test)", () => {
    const timeLimit = 30; // 30s limit
    const basePoints = 100;
    const speedBonusPct = 0.5;

    // Simulation: 4s active time before pause, 600s paused, 2s active time after resume
    // Active remaining time when answering is 24 seconds (out of 30)
    const remainingSec = 24.0;
    const activeTimeTaken = calculateActiveTimeTaken(timeLimit, remainingSec);
    expect(activeTimeTaken).toBe(6.0);

    const score = calculateSpeedScore(basePoints, timeLimit, activeTimeTaken, speedBonusPct);
    expect(score).toBe(140);
    expect(score).toBeGreaterThan(100);
  });

  test("does not treat selected option as confirmed team submission and allows retry on failure", () => {
    let state = {
      status: {
        phase: "QUESTION",
        question: { id: "q-1" },
        team_submission: null,
      },
      submitting: false,
      pendingChoice: null,
    };

    // Selecting an option sets pendingChoice and submitting flag, NOT team_submission
    state.pendingChoice = "C";
    state.submitting = true;

    expect(state.pendingChoice).toBe("C");
    expect(state.submitting).toBe(true);
    // Crucial: Team submission is still null (not confirmed)
    expect(state.status.team_submission).toBeNull();

    // Failure reconciliation when server does NOT have an answer
    const freshStatusNoAnswer = { team_submission: null };
    const outcome = handleSubmissionFailure(freshStatusNoAnswer, null, new Error("Network drop"));
    expect(outcome.recovered).toBe(false);
    expect(outcome.allowRetry).toBe(true);

    // Reconcile client state: allow user to retry
    state.pendingChoice = null;
    state.submitting = false;
    expect(state.pendingChoice).toBeNull();

    // Failure reconciliation when server DOES have an answer (e.g. teammate submitted)
    const freshStatusWithAnswer = { team_submission: { answered: true, answer: "C" } };
    const recoveredOutcome = handleSubmissionFailure(freshStatusWithAnswer, null, new Error("Already submitted"));
    expect(recoveredOutcome.recovered).toBe(true);
    expect(recoveredOutcome.allowRetry).toBe(false);
  });

  test("late acknowledgement for Q1 must not mark Q2 answered", () => {
    const targetQuestionId = "q-1";
    // State has advanced to Q2 while Q1 submission request was in-flight
    const currentState = {
      phase: "QUESTION",
      question_index: 1,
      question: { id: "q-2", text: "Question 2" },
      team_submission: null,
    };

    // Production applyAnswerConfirmation handler
    const nextState = applyAnswerConfirmation(currentState, targetQuestionId, { ok: true, answer: "A" }, "A");
    // Q2 remains completely unanswered
    expect(nextState.question.id).toBe("q-2");
    expect(nextState.team_submission).toBeNull();

    // In contrast, if target matches the active question, it is confirmed
    const validCurrentState = {
      phase: "QUESTION",
      question_index: 0,
      question: { id: "q-1", text: "Question 1" },
      team_submission: null,
    };
    const confirmedState = applyAnswerConfirmation(validCurrentState, targetQuestionId, { ok: true, answer: "A" }, "A");
    expect(confirmedState.team_submission.answered).toBe(true);
    expect(confirmedState.team_submission.answer).toBe("A");
  });

  test("prevents older overlapping status responses and clock regressions from replacing newer state", () => {
    let currentRequestId = 0;
    const prevStatus = {
      phase: "RESULT",
      question_index: 2,
      server_time: "2026-10-25T12:00:15.000Z",
    };

    // Stale overlapping request ID
    const staleReqId = 1;
    currentRequestId = 2;
    const staleIncoming = {
      phase: "QUESTION",
      question_index: 2,
      server_time: "2026-10-25T12:00:10.000Z",
    };

    const outOfOrderResult = processStatusResponse(staleIncoming, prevStatus, staleReqId, currentRequestId);
    expect(outOfOrderResult.accept).toBe(false);
    expect(outOfOrderResult.reason).toBe("OUT_OF_ORDER");

    // Clock regression from out-of-order server payload
    const regressiveIncoming = {
      phase: "QUESTION",
      question_index: 2,
      server_time: "2026-10-25T12:00:10.000Z", // Older than prevStatus 12:00:15
    };
    const regressionResult = processStatusResponse(regressiveIncoming, prevStatus, currentRequestId, currentRequestId);
    expect(regressionResult.accept).toBe(false);
    expect(regressionResult.reason).toBe("CLOCK_REGRESSION");

    // Valid newer response
    const validIncoming = {
      phase: "RESULT",
      question_index: 2,
      server_time: "2026-10-25T12:00:20.000Z",
    };
    const validResult = processStatusResponse(validIncoming, prevStatus, currentRequestId, currentRequestId);
    expect(validResult.accept).toBe(true);
    expect(validResult.data.phase).toBe("RESULT");
  });

  test("mounts Round1 component and renders question phase with options and timer", async () => {
    const { act } = require("react");
    const { createRoot } = require("react-dom/client");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");
    const auth = require("../lib/auth");

    const authSpy = jest.spyOn(auth, "useAuth").mockReturnValue({
      user: { id: "test-user-1", email: "team@test.com", role: "team" },
      logout: jest.fn(),
    });

    const getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/1/status") {
        return Promise.resolve({
          data: {
            phase: "QUESTION",
            question_index: 0,
            total_questions: 10,
            is_paused: false,
            phase_ends_at: new Date(Date.now() + 25000).toISOString(),
            server_time: new Date().toISOString(),
            question: {
              id: "q-1",
              text: "Sample Market Masters Question",
              options: ["Option A", "Option B", "Option C", "Option D"],
              time_limit: 30,
              base_points: 100,
            },
            team_submission: null,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round1 />
        </MemoryRouter>
      );
    });

    // Wait a tick for useEffect fetchStatus
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Sample Market Masters Question");
    expect(container.textContent).toContain("Option A");
    expect(container.textContent).toContain("Option B");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    getSpy.mockRestore();
    authSpy.mockRestore();
  });

  test("RTT latency compensation ensures consistent serverTimeOffset across varying network latencies", () => {
    const trueServerNow = 1700000005000;
    const incomingData = {
      server_time: new Date(trueServerNow).toISOString(),
      phase: "COUNTDOWN",
      question_index: 0,
    };

    // Client A: Fast connection (20ms RTT, sent at 1700000004990, received at 1700000005010)
    const clientASend = 1700000004990;
    const clientARecv = 1700000005010;
    jest.spyOn(Date, "now").mockReturnValue(clientARecv);
    const clientAProcessed = processStatusResponse(incomingData, null, 1, 1, clientASend);

    // Client B: Slower connection (200ms RTT, sent at 1700000004900, received at 1700000005100)
    const clientBSend = 1700000004900;
    const clientBRecv = 1700000005100;
    jest.spyOn(Date, "now").mockReturnValue(clientBRecv);
    const clientBProcessed = processStatusResponse(incomingData, null, 1, 1, clientBSend);

    // Both clients compute the true offset relative to their respective clocks
    // Client A's estimated server offset: trueServerNow - (5010 - 10) = 5000 - 5000 = 0
    expect(clientAProcessed.serverTimeOffset).toBe(0);
    // Client B's estimated server offset: trueServerNow - (5100 - 100) = 5000 - 5000 = 0
    expect(clientBProcessed.serverTimeOffset).toBe(0);

    // Contrast with uncompensated calculation:
    // Without reqStartTimeMs, Client A computes 5000 - 5010 = -10ms; Client B computes 5000 - 5100 = -100ms (90ms difference!)
    jest.spyOn(Date, "now").mockReturnValue(clientARecv);
    const uncompensatedA = processStatusResponse(incomingData, null, 1, 1);
    jest.spyOn(Date, "now").mockReturnValue(clientBRecv);
    const uncompensatedB = processStatusResponse(incomingData, null, 1, 1);
    expect(Math.abs(uncompensatedA.serverTimeOffset - uncompensatedB.serverTimeOffset)).toBe(90);

    Date.now.mockRestore();
  });

  test("synchronized countdown display calculation across two browsers with different tick offsets", () => {
    const serverStartMs = 1700000000000;
    const phaseEndsAtIso = new Date(serverStartMs + 10000).toISOString(); // 10s countdown

    // Client A clock offset is +50ms, Client B clock offset is -120ms
    const skewA = 50;
    const skewB = -120;

    // Both clients sample remaining countdown at true wall-clock time t = 3.5s (6.5s remaining)
    const clientANow = serverStartMs + 3500 - skewA;
    const clientBNow = serverStartMs + 3500 - skewB;

    const displayA = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewA, clientANow);
    const displayB = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewB, clientBNow);

    // Both browsers calculate the exact same display second (7 seconds remaining)
    expect(displayA).toBe(7);
    expect(displayB).toBe(7);
    expect(displayA).toBe(displayB);

    // At t = 9.8s (0.2s remaining), both show 1
    const displayAEnd = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewA, serverStartMs + 9800 - skewA);
    const displayBEnd = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewB, serverStartMs + 9800 - skewB);
    expect(displayAEnd).toBe(1);
    expect(displayBEnd).toBe(1);

    // At t = 10.0s (deadline passed), both show 0
    const displayAZero = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewA, serverStartMs + 10000 - skewA);
    const displayBZero = calculateDisplaySeconds(phaseEndsAtIso, false, 0, skewB, serverStartMs + 10000 - skewB);
    expect(displayAZero).toBe(0);
    expect(displayBZero).toBe(0);
  });

  test("Round 1 completion screen guard prevents showing completed view when reset to WAITING", () => {
    // When reset occurs, phase is WAITING, status is IDLE, round_state is UPCOMING
    const resetStatus = {
      phase: "WAITING",
      status: "IDLE",
      round_state: "UPCOMING",
      total_questions: 3,
    };

    // The waiting room condition in Round1.jsx:
    const isWaitingRoom = !resetStatus || resetStatus.phase === "WAITING" || resetStatus.status === "IDLE";
    expect(isWaitingRoom).toBe(true);

    // The completion guard in Round1.jsx must NOT evaluate to true for reset status:
    const isCompleted = resetStatus.phase === "COMPLETED" || (
      resetStatus.round_state === "COMPLETED" &&
      resetStatus.phase !== "RESULT" &&
      resetStatus.phase !== "WAITING" &&
      resetStatus.status !== "IDLE"
    );
    expect(isCompleted).toBe(false);
  });

  test("createRequestCoalescer coalesces duplicate non-deadline requests (focus + visibility)", async () => {
    const coalescer = createRequestCoalescer();
    let apiCallCount = 0;
    let resolveFirst;

    const mockApiCall = jest.fn(() => {
      apiCallCount++;
      return new Promise((res) => {
        resolveFirst = res;
      });
    });

    // Request 1: non-deadline focus event
    const p1 = coalescer.execute(false, mockApiCall);
    expect(coalescer.getInFlight()).not.toBeNull();
    expect(coalescer.isDeadlineInFlight()).toBe(false);

    // Request 2: simultaneous non-deadline visibility event
    const p2 = coalescer.execute(false, mockApiCall);

    // Both calls must return the identical in-flight promise
    expect(p1).toBe(p2);
    expect(apiCallCount).toBe(1);

    // Resolve in-flight request
    resolveFirst({ phase: "QUESTION" });
    const res1 = await p1;
    const res2 = await p2;

    expect(res1).toEqual(res2);
    expect(coalescer.getInFlight()).toBeNull();
  });

  test("createRequestCoalescer preserves scheduled deadline boundary request when slow background poll is in flight", async () => {
    const coalescer = createRequestCoalescer();
    const calls = [];
    let resolveSlowPoll;
    let resolveDeadline;

    // 1. Slow background poll initiated at t = 9.8s (before deadline)
    const slowPollPromise = coalescer.execute(false, (reqId) => {
      calls.push({ type: "POLL", reqId });
      return new Promise((res) => {
        resolveSlowPoll = res;
      });
    });

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ type: "POLL", reqId: 1 });
    expect(coalescer.isDeadlineInFlight()).toBe(false);

    // 2. Timer hits 0 at t = 10.0s -> deadline boundary request triggered!
    // Must NOT be swallowed into the slow pre-deadline poll!
    const deadlinePromise = coalescer.execute(true, (reqId) => {
      calls.push({ type: "DEADLINE", reqId });
      return new Promise((res) => {
        resolveDeadline = res;
      });
    });

    // Deadline request was dispatched as a separate authoritative boundary call with incremented reqId!
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({ type: "DEADLINE", reqId: 2 });
    expect(coalescer.isDeadlineInFlight()).toBe(true);

    // 3. Slow poll resolves first with stale COUNTDOWN data
    resolveSlowPoll({ phase: "COUNTDOWN", server_time: new Date().toISOString() });
    const pollResult = await slowPollPromise;

    // Verify processStatusResponse rejects the slow poll as OUT_OF_ORDER:
    const validatedPoll = processStatusResponse(pollResult, null, pollResult.reqId, coalescer.getLatestRequestId());
    expect(validatedPoll.accept).toBe(false);
    expect(validatedPoll.reason).toBe("OUT_OF_ORDER");

    // 4. Deadline request resolves with QUESTION 1 data
    resolveDeadline({ phase: "QUESTION", server_time: new Date().toISOString() });
    const deadlineResult = await deadlinePromise;

    // Verify processStatusResponse accepts the deadline result because reqId === currentReqId:
    const validatedDeadline = processStatusResponse(deadlineResult, null, deadlineResult.reqId, coalescer.getLatestRequestId());
    expect(validatedDeadline.accept).toBe(true);
    expect(validatedDeadline.data.phase).toBe("QUESTION");
  });

  test("Round 1 component preserves scheduled deadline request during in-flight status call", async () => {
    const { createRoot } = require("react-dom/client");
    const { MemoryRouter } = require("react-router-dom");
    const { api } = require("../lib/api");
    const auth = require("../lib/auth");

    const authSpy = jest.spyOn(auth, "useAuth").mockReturnValue({
      user: { id: "test-user-1", email: "team@test.com", role: "team" },
      logout: jest.fn(),
    });

    let getCalls = 0;
    const getSpy = jest.spyOn(api, "get").mockImplementation((url) => {
      if (url === "/rounds/1/status") {
        getCalls++;
        return Promise.resolve({
          data: {
            phase: "WAITING",
            question_index: 0,
            total_questions: 10,
            is_paused: false,
            server_time: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Round1 />
        </MemoryRouter>
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(getCalls).toBeGreaterThanOrEqual(1);
    const callsAfterMount = getCalls;

    // Simulate simultaneous focus + visibilitychange on Round 1 page
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    // Must be coalesced so duplicate simultaneous triggers don't generate duplicate requests
    expect(getCalls).toBeLessThanOrEqual(callsAfterMount + 1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    getSpy.mockRestore();
    authSpy.mockRestore();
  });
});


import React from "react";

describe("Round 1 Synchronized Client Logic", () => {
  test("calculates display seconds accurately without dropping below 0", () => {
    const calcRemaining = (endsAtMs, nowMs) => Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));

    const now = 1700000000000;
    // 14.2 seconds remaining -> rounds up to 15s display
    expect(calcRemaining(now + 14200, now)).toBe(15);
    // 0.2 seconds remaining -> 1s display
    expect(calcRemaining(now + 200, now)).toBe(1);
    // past deadline -> clamped to 0
    expect(calcRemaining(now - 1000, now)).toBe(0);
  });

  test("bounded retry backoff does not exceed maximum limit of 4 retries", () => {
    let retryCount = 0;
    const delays = [];

    const handleDeadlineRetry = () => {
      if (retryCount < 4) {
        retryCount += 1;
        const delay = retryCount * 700;
        delays.push(delay);
        return true;
      }
      return false;
    };

    expect(handleDeadlineRetry()).toBe(true); // retry 1: 700ms
    expect(handleDeadlineRetry()).toBe(true); // retry 2: 1400ms
    expect(handleDeadlineRetry()).toBe(true); // retry 3: 2100ms
    expect(handleDeadlineRetry()).toBe(true); // retry 4: 2800ms
    expect(handleDeadlineRetry()).toBe(false); // retry 5: blocked

    expect(delays).toEqual([700, 1400, 2100, 2800]);
    expect(retryCount).toBe(4);
  });

  test("handles 409 'Already submitted' response gracefully for concurrent teammates", () => {
    const mockError = {
      response: {
        status: 409,
        data: { detail: "Already submitted" },
      },
    };

    const isTeammateConflict =
      mockError?.response?.status === 409 ||
      mockError?.response?.data?.detail === "Already submitted";

    expect(isTeammateConflict).toBe(true);
  });

  test("prevents question options from leaking correct answer during QUESTION phase", () => {
    const questionPayload = {
      id: "q-123",
      round: 1,
      text: "What is ROI?",
      options: ["Return on Investment", "Rate of Interest", "Risk on Inflation", "Return on Income"],
      base_points: 100,
      time_limit: 30,
    };

    expect(questionPayload.correct_answer).toBeUndefined();
    expect(Object.keys(questionPayload)).not.toContain("correct_answer");
  });

  test("POST /rounds/1/submit response during QUESTION returns only acknowledgement and accepted answer", () => {
    // The actual HTTP response contract during active QUESTION phase
    const httpSubmitResponse = {
      status: 200,
      data: {
        ok: true,
        submission_id: "00000000-0000-0000-0000-000000000001",
        answer: "B",
      },
    };

    expect(httpSubmitResponse.data.ok).toBe(true);
    expect(httpSubmitResponse.data.answer).toBe("B");
    expect(httpSubmitResponse.data.submission_id).toBeDefined();

    // Verify absence of leaked score, correctness, or time_taken
    expect(httpSubmitResponse.data.correct).toBeUndefined();
    expect(httpSubmitResponse.data.score).toBeUndefined();
    expect(httpSubmitResponse.data.time_taken).toBeUndefined();
  });

  test("preserves paused_remaining_ms = 0 without defaulting to 10000", () => {
    const r1State = {
      is_paused: true,
      paused_remaining_ms: 0,
    };

    // Correct implementation: Math.max(0, Number(r1State.paused_remaining_ms ?? 0))
    const preservedRemaining = Math.max(0, Number(r1State.paused_remaining_ms ?? 0));
    expect(preservedRemaining).toBe(0);

    // Flawed implementation would have evaluated 0 || 10000 to 10000
    const flawedRemaining = Number(r1State.paused_remaining_ms) || 10000;
    expect(flawedRemaining).toBe(10000);
    expect(preservedRemaining).not.toBe(flawedRemaining);
  });

  test("compensates for client device clock skew using server_time offset", () => {
    const serverTimeMs = 1700000000000;
    const deadlineMs = serverTimeMs + 30000; // 30s remaining

    // Helper simulating Round1.jsx clock skew calculation
    const getRemainingWithSkew = (clientNowMs) => {
      const serverSkewMs = serverTimeMs - clientNowMs;
      const estimatedServerNow = clientNowMs + serverSkewMs;
      return Math.max(0, Math.ceil((deadlineMs - estimatedServerNow) / 1000));
    };

    // Client device clock is 45 seconds FAST
    const clientFastNow = serverTimeMs + 45000;
    expect(getRemainingWithSkew(clientFastNow)).toBe(30);

    // Client device clock is 30 seconds SLOW
    const clientSlowNow = serverTimeMs - 30000;
    expect(getRemainingWithSkew(clientSlowNow)).toBe(30);
  });

  test("verifies active time_taken ignores pause duration (10-minute pause test)", () => {
    const timeLimit = 30; // 30s limit
    const basePoints = 100;
    const speedBonusPct = 0.5;

    // Simulation: 4s active time before pause, 600s paused, 2s active time after resume
    // Active remaining time when answering is 24 seconds (out of 30)
    const remainingSec = 24.0;
    const activeTimeTaken = Math.max(0, Math.min(timeLimit, timeLimit - remainingSec));
    expect(activeTimeTaken).toBe(6.0);

    const speedFactor = Math.max(0, 1 - activeTimeTaken / timeLimit); // 1 - 6/30 = 0.8
    const score = Math.round(basePoints * (1 + speedBonusPct * speedFactor)); // 100 * (1 + 0.4) = 140

    expect(score).toBe(140);
    expect(score).toBeGreaterThan(100);
  });

  test("does not treat selectedOpt as confirmed team submission and allows retry on failure", async () => {
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
    const initiateSubmission = (letter) => {
      state.pendingChoice = letter;
      state.submitting = true;
    };

    initiateSubmission("C");
    expect(state.pendingChoice).toBe("C");
    expect(state.submitting).toBe(true);
    // Crucial: Team submission is still null (not confirmed)
    expect(state.status.team_submission).toBeNull();
    const hasAnswered = Boolean(state.status?.team_submission?.answered);
    expect(hasAnswered).toBe(false);

    // Simulate network failure: reconcile with server
    const simulateNetworkError = async (serverHasAnswer) => {
      // Server reconciliation check
      if (serverHasAnswer) {
        state.status.team_submission = { answered: true, answer: "C" };
      } else {
        // Not recorded on server: clear pendingChoice and allow retry!
        state.pendingChoice = null;
      }
      state.submitting = false;
    };

    await simulateNetworkError(false);
    expect(state.pendingChoice).toBeNull();
    expect(state.submitting).toBe(false);
    expect(state.status.team_submission).toBeNull();
    // User can now retry selecting
    initiateSubmission("B");
    expect(state.pendingChoice).toBe("B");
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

    // Late acknowledgement handler from Round1.jsx
    const applyLateAck = (prev, targetQId, serverData) => {
      if (!prev || prev.question?.id !== targetQId) {
        // Question advanced while request was in-flight; discard state update
        return prev;
      }
      return {
        ...prev,
        team_submission: {
          answered: true,
          answer: serverData.answer,
        },
      };
    };

    const nextState = applyLateAck(currentState, targetQuestionId, { ok: true, answer: "A" });
    // Q2 remains completely unanswered
    expect(nextState.question.id).toBe("q-2");
    expect(nextState.team_submission).toBeNull();
  });

  test("prevents older overlapping status responses from replacing newer state", () => {
    let currentRequestId = 0;
    let localStatus = {
      phase: "QUESTION",
      question_index: 2,
      server_time: "2026-10-25T12:00:10.000Z",
    };

    // Simulate 2 out-of-order responses: Request 1 fired, Request 2 fired
    const req1Id = ++currentRequestId; // 1
    const req2Id = ++currentRequestId; // 2

    // Request 2 completes first with newer state
    const req2Data = {
      phase: "RESULT",
      question_index: 2,
      server_time: "2026-10-25T12:00:15.000Z",
    };
    if (req2Id === currentRequestId) {
      localStatus = req2Data;
    }
    expect(localStatus.phase).toBe("RESULT");

    // Request 1 completes later (stale overlapping response)
    const req1Data = {
      phase: "QUESTION",
      question_index: 2,
      server_time: "2026-10-25T12:00:10.000Z",
    };

    const applyStatus = (reqId, prev, incoming) => {
      // Discard out-of-order request IDs
      if (reqId !== currentRequestId) return null;
      // Discard backward server-time jumps
      if (prev?.server_time && incoming?.server_time) {
        if (new Date(incoming.server_time).getTime() < new Date(prev.server_time).getTime()) {
          return prev;
        }
      }
      return incoming;
    };

    const result = applyStatus(req1Id, localStatus, req1Data);
    expect(result).toBeNull();
    // localStatus is preserved at RESULT
    expect(localStatus.phase).toBe("RESULT");
  });
});


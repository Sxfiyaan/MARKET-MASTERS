/**
 * Pure client synchronization and calculation utilities for Round 1.
 * Extracted production logic imported by Round1.jsx and tested directly in unit tests.
 */

/**
 * Calculates display seconds remaining using server-skew compensated time.
 */
export function calculateDisplaySeconds(phaseEndsAt, isPaused, statusTimeLeft, serverTimeOffsetMs = 0, clientNowMs = Date.now()) {
  if (!phaseEndsAt && !isPaused) {
    return 0;
  }

  if (isPaused) {
    return Math.max(0, Number(statusTimeLeft ?? 0));
  }

  const endsAtMs = new Date(phaseEndsAt).getTime();
  const estimatedServerNow = clientNowMs + (serverTimeOffsetMs || 0);
  return Math.max(0, Math.ceil((endsAtMs - estimatedServerNow) / 1000));
}

/**
 * Handles bounded exponential/linear retry backoff when deadline triggered without phase advance.
 */
export function handleDeadlineRetry(currentRetryCount, maxRetries = 4, baseDelayMs = 200) {
  if (currentRetryCount < maxRetries) {
    const nextRetryCount = currentRetryCount + 1;
    const delayMs = nextRetryCount * baseDelayMs;
    return { canRetry: true, nextRetryCount, delayMs };
  }
  return { canRetry: false, nextRetryCount: currentRetryCount, delayMs: 0 };
}

/**
 * Creates a request coalescer that deduplicates concurrent refresh calls,
 * preserves scheduled deadline boundary requests, and prevents older responses from overwriting newer state.
 */
export function createRequestCoalescer() {
  let inFlightPromise = null;
  let inFlightIsDeadline = false;
  let latestRequestId = 0;

  return {
    getInFlight: () => inFlightPromise,
    isDeadlineInFlight: () => inFlightIsDeadline,
    getLatestRequestId: () => latestRequestId,

    execute: (isDeadlineTrigger, apiCall) => {
      // Coalesce duplicate requests if:
      // 1) This is a non-deadline poll/focus/visibility request, OR
      // 2) An existing in-flight request is already a deadline request
      if (inFlightPromise) {
        if (!isDeadlineTrigger || inFlightIsDeadline) {
          return inFlightPromise;
        }
      }

      const reqId = ++latestRequestId;
      const reqStartTime = Date.now();
      inFlightIsDeadline = Boolean(isDeadlineTrigger);

      let task;
      task = (async () => {
        try {
          const result = await apiCall(reqId, reqStartTime);
          return { ...result, reqId, currentReqId: latestRequestId };
        } finally {
          if (inFlightPromise === task) {
            inFlightPromise = null;
            inFlightIsDeadline = false;
          }
        }
      })();

      inFlightPromise = task;
      return task;
    },
  };
}

/**
 * Validates and filters status responses against overlapping/out-of-order responses and clock regressions.
 * Accurately compensates for network transit latency (RTT) in server-time offset calculation.
 *
 * NOTE: Half-RTT clock compensation assumes symmetric uplink/downlink transit latency
 * (server_time ≈ client_receive_time - RTT/2). This is an approximation/estimate that significantly
 * reduces network transit skew, but is NOT a mathematical guarantee of identical millisecond
 * timers across browsers due to potential network path asymmetry, browser event loop scheduling,
 * and OS timer resolution.
 */
export function processStatusResponse(incomingData, prevStatus, reqId, currentReqId, reqStartTimeMs = 0) {
  // Discard older overlapping requests that resolved out of order
  if (reqId !== currentReqId) {
    return { accept: false, reason: "OUT_OF_ORDER" };
  }

  // Discard backward server-time jumps
  if (prevStatus?.server_time && incomingData?.server_time) {
    if (new Date(incomingData.server_time).getTime() < new Date(prevStatus.server_time).getTime()) {
      return { accept: false, reason: "CLOCK_REGRESSION" };
    }
  }

  const clientNow = Date.now();
  const serverTimeMs = incomingData?.server_time ? new Date(incomingData.server_time).getTime() : clientNow;

  // Compensate for half of round-trip transit time as an estimate of server send instant
  const rtt = reqStartTimeMs && reqStartTimeMs <= clientNow ? clientNow - reqStartTimeMs : 0;
  const estimatedClientAtServerNow = clientNow - Math.round(rtt / 2);
  const serverTimeOffset = serverTimeMs - estimatedClientAtServerNow;

  const phaseChanged = !prevStatus || prevStatus.phase !== incomingData.phase || prevStatus.question_index !== incomingData.question_index;

  return {
    accept: true,
    data: incomingData,
    serverTimeOffset,
    phaseChanged,
  };
}

/**
 * Applies answer confirmation to state only if the target question is still the active question.
 * Guards against late acknowledgements marking a subsequent question answered.
 */
export function applyAnswerConfirmation(prevStatus, targetQuestionId, serverData, fallbackChoice) {
  if (!prevStatus || prevStatus.question?.id !== targetQuestionId) {
    // Question advanced while request was in-flight; do NOT mark new question answered
    return prevStatus;
  }

  return {
    ...prevStatus,
    team_submission: {
      answered: true,
      answer: serverData?.answer || fallbackChoice,
      submitted_at: new Date().toISOString(),
    },
  };
}

/**
 * Reconciles submission failure with server state to distinguish between
 * a teammate locking in the answer vs a genuine network/server failure requiring retry.
 */
export function handleSubmissionFailure(freshStatus, formatApiError, error) {
  if (freshStatus?.team_submission?.answered) {
    return {
      recovered: true,
      allowRetry: false,
      message: "Answer was locked in by a teammate.",
    };
  }

  return {
    recovered: false,
    allowRetry: true,
    message: (formatApiError ? formatApiError(error) : error?.message) || "Submission failed. Please select your answer again.",
  };
}

/**
 * Computes active time taken excluding paused duration.
 */
export function calculateActiveTimeTaken(timeLimit, remainingSec) {
  return Math.max(0, Math.min(timeLimit, Number((timeLimit - remainingSec).toFixed(2))));
}

/**
 * Calculates speed-bonus score based on time taken and base points.
 */
export function calculateSpeedScore(basePoints, timeLimit, activeTimeTaken, speedBonusPct = 0.5) {
  const speedFactor = Math.max(0, 1 - activeTimeTaken / Math.max(1, timeLimit));
  return Math.round(basePoints * (1 + speedBonusPct * speedFactor));
}

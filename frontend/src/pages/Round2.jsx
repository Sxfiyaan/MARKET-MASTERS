import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import {
  calculateDisplaySeconds,
  handleDeadlineRetry,
  processStatusResponse,
  applyAnswerConfirmation,
  handleSubmissionFailure,
} from "@/lib/round1Sync";
import { toast } from "sonner";
import { Link } from "react-router-dom";

export default function Round2() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pendingChoice, setPendingChoice] = useState(null);
  const [explanationDraft, setExplanationDraft] = useState("");

  // Local display seconds remaining for the current phase
  const [displayTime, setDisplayTime] = useState(0);

  // Refs for tracking timer, transition requests, and sequence numbers
  const statusRef = useRef(null);
  statusRef.current = status;

  const deadlineRequestedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(null);

  // Server time offset estimation (server_time ≈ client_recv - RTT/2)
  const serverTimeOffsetRef = useRef(0);
  const statusRequestIdRef = useRef(0);
  const inFlightPromiseRef = useRef(null);
  const inFlightIsDeadlineRef = useRef(false);

  // Fetch status from server with overlapping response protection, coalescing, and latency compensation
  const fetchStatus = useCallback(async (isDeadlineTrigger = false) => {
    if (inFlightPromiseRef.current) {
      if (!isDeadlineTrigger || inFlightIsDeadlineRef.current) {
        return inFlightPromiseRef.current;
      }
    }

    const reqId = ++statusRequestIdRef.current;
    const reqStartTime = Date.now();
    inFlightIsDeadlineRef.current = Boolean(isDeadlineTrigger);

    const task = (async () => {
      try {
        const { data } = await api.get("/rounds/2/status");

        const processed = processStatusResponse(data, statusRef.current, reqId, statusRequestIdRef.current, reqStartTime);
        if (!processed.accept) {
          return processed.reason === "CLOCK_REGRESSION" ? statusRef.current : null;
        }

        setStatus(processed.data);
        setLoading(false);
        serverTimeOffsetRef.current = processed.serverTimeOffset;

        // Draft clearing across resets, idle, countdown, or question changes
        const isResetOrIdle = processed.data.status === "IDLE" || processed.data.phase === "WAITING";
        const isCountdown = processed.data.phase === "COUNTDOWN";
        const hasPrevQuestion = Boolean(statusRef.current?.question?.id);
        const hasNewQuestion = Boolean(processed.data.question?.id);
        const questionChanged = hasPrevQuestion && hasNewQuestion && (
          statusRef.current.question.id !== processed.data.question.id
        );

        if (isResetOrIdle || isCountdown || questionChanged) {
          setPendingChoice(null);
          setExplanationDraft("");
        } else if (processed.data.team_submission?.answered) {
          setPendingChoice(null);
        }

        if (processed.phaseChanged) {
          deadlineRequestedRef.current = false;
          retryCountRef.current = 0;
          if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }
        } else if (isDeadlineTrigger) {
          const retry = handleDeadlineRetry(retryCountRef.current);
          if (retry.canRetry) {
            retryCountRef.current = retry.nextRetryCount;
            retryTimerRef.current = setTimeout(() => {
              fetchStatus(true);
            }, retry.delayMs);
          }
        }
        return processed.data;
      } catch (e) {
        setLoading(false);
        return null;
      } finally {
        if (inFlightPromiseRef.current === task) {
          inFlightPromiseRef.current = null;
          inFlightIsDeadlineRef.current = false;
        }
      }
    })();

    inFlightPromiseRef.current = task;
    return task;
  }, []);

  // Initial load
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Modest background poll every 3.5s to catch pause/resume and external state changes
  useEffect(() => {
    const backupInterval = setInterval(() => {
      fetchStatus(false);
    }, 3500);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchStatus(false);
      }
    };
    const onFocus = () => fetchStatus(false);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(backupInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchStatus]);

  // Cleanup any pending retry timeouts
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const phaseEndsAt = status?.phase_ends_at;
  const isPaused = status?.is_paused;
  const statusTimeLeft = status?.time_left;

  // Sync display timer with status ends_at or frozen paused time using server-skew corrected clock
  useEffect(() => {
    const calcRemaining = () =>
      calculateDisplaySeconds(
        phaseEndsAt,
        isPaused,
        statusTimeLeft,
        serverTimeOffsetRef.current,
        Date.now()
      );

    setDisplayTime(calcRemaining());

    if (!phaseEndsAt && !isPaused) return;

    const tickInterval = setInterval(() => {
      if (statusRef.current?.is_paused) return;

      const remainingSec = calcRemaining();
      setDisplayTime(remainingSec);

      if (remainingSec === 0 && !deadlineRequestedRef.current) {
        deadlineRequestedRef.current = true;
        fetchStatus(true);
      }
    }, 200);

    return () => clearInterval(tickInterval);
  }, [phaseEndsAt, isPaused, statusTimeLeft, fetchStatus]);

  // Combined Decision + Explanation submission
  const submitDecision = useCallback(async () => {
    if (!status || status.phase !== "QUESTION" || !status.question || submitting) return;
    if (status.team_submission?.answered) return;
    if (status.is_paused) {
      toast.error("Round 2 is currently paused.");
      return;
    }
    if (!pendingChoice) {
      toast.error("Please select a decision: BUY, SELL, or NO TRADE.");
      return;
    }

    const cleanExplanation = explanationDraft.trim();
    if (!cleanExplanation) {
      toast.error("Explanation is mandatory. Please provide a brief rationale.");
      return;
    }
    if (cleanExplanation.length > 250) {
      toast.error("Explanation must not exceed 250 characters.");
      return;
    }

    const targetQuestionId = status.question.id;
    setSubmitting(true);

    try {
      const { data } = await api.post("/rounds/2/submit", {
        question_id: targetQuestionId,
        answer: pendingChoice,
        explanation: cleanExplanation,
      });

      setStatus((prev) => {
        if (!prev || prev.question?.id !== targetQuestionId) return prev;
        const prevSub = prev.team_submission || {};
        return {
          ...prev,
          team_submission: {
            ...prevSub,
            answered: true,
            answer: data?.answer || prevSub.answer || pendingChoice,
            explanation: data?.explanation || prevSub.explanation || cleanExplanation,
            submitted_at: prevSub.submitted_at || new Date().toISOString(),
            ...(prevSub.correct !== undefined ? { correct: prevSub.correct } : {}),
            ...(prevSub.score !== undefined ? { score: prevSub.score } : {}),
          },
        };
      });
      toast.success("Decision locked in!");
      // Reconcile with authoritative status after acknowledgement
      await fetchStatus(false);
    } catch (e) {
      const freshStatus = await fetchStatus(false);
      const outcome = handleSubmissionFailure(freshStatus, formatApiError, e);
      if (outcome.recovered) {
        toast.info(outcome.message);
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [status, submitting, pendingChoice, explanationDraft, fetchStatus]);

  // Confirmed team submission
  const hasAnswered = Boolean(status?.team_submission?.answered);
  const lockedAnswer = status?.team_submission?.answer || (hasAnswered ? pendingChoice : null);
  const lockedExplanation = status?.team_submission?.explanation || (hasAnswered ? explanationDraft : "");

  if (loading && !status) {
    return (
      <Shell>
        <div className="font-mono text-sm text-mm-text2 flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-mm-gold animate-ping" />
          Synchronizing trading floor…
        </div>
      </Shell>
    );
  }

  // 1. WAITING ROOM (Round 2 is UPCOMING or WAITING)
  if (!status || status.phase === "WAITING" || status.status === "IDLE") {
    const totalQ = status?.total_questions || 5;
    return (
      <Shell>
        <div className="mm-panel mm-corner-ticks p-8 sm:p-12 max-w-2xl mx-auto" data-testid="r2-waiting-room">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 02 · WAITING ROOM</div>
            <span className="font-mono text-[10px] tracking-widest px-2.5 py-1 border border-mm-gold/40 text-mm-gold">
              STANDBY
            </span>
          </div>

          <h1 className="font-serif text-4xl sm:text-5xl mt-5">THE CALL</h1>
          <p className="text-mm-text2 mt-4 font-mono text-sm leading-relaxed">
            The auditorium screen will present 5 real market charts. Your desk will analyze each chart and submit a unified decision: <strong>BUY</strong>, <strong>SELL</strong>, or <strong>NO TRADE</strong> along with a mandatory concise rationale.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-8 pt-8 border-t border-mm-border">
            <div className="p-4 bg-mm-panel/50 border border-mm-border">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Chart Set</div>
              <div className="font-mono text-2xl mt-1 text-mm-text" data-testid="r2-total-questions">
                {totalQ} Charts
              </div>
            </div>
            <div className="p-4 bg-mm-panel/50 border border-mm-border">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Display</div>
              <div className="font-mono text-sm mt-1 text-mm-gold">Auditorium Screen</div>
            </div>
            <div className="p-4 bg-mm-panel/50 border border-mm-border col-span-2 sm:col-span-1">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Scoring</div>
              <div className="font-mono text-sm mt-1 text-mm-green">1 Pt Correct / 0 Pt Other</div>
            </div>
          </div>

          <div className="mt-8 p-4 bg-black/40 border border-mm-border font-mono text-xs text-mm-text2 leading-relaxed">
            <span className="text-mm-gold font-bold">EVENT PROTOCOL:</span> Any teammate may submit on behalf of the team. Only the first accepted decision counts. Explanations must be plain text and under 250 characters.
          </div>

          <div className="mt-10 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-mm-text2">
              <span className="w-2 h-2 rounded-full bg-mm-green animate-pulse" />
              Connected to floor controller
            </div>
            <Link to="/dashboard" className="btn-ghost" data-testid="r2-back-dashboard">
              Back to Dashboard
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  // 2. COUNTDOWN PHASE
  if (status.phase === "COUNTDOWN") {
    const chartNum = (status.question_index ?? 0) + 1;
    return (
      <Shell>
        <div className="max-w-xl mx-auto text-center py-16" data-testid="r2-countdown">
          <div className="font-mono text-xs tracking-[0.3em] text-mm-gold animate-pulse">
            // SYNCHRONIZED COUNTDOWN
          </div>
          <h2 className="font-serif text-3xl sm:text-4xl mt-4">Chart {chartNum} Incoming</h2>
          <p className="text-mm-text2 mt-3 font-mono text-sm">
            Focus on the main auditorium screen. Chart #{chartNum} is about to open.
          </p>

          <div className="font-mono text-8xl sm:text-9xl font-bold mt-10 text-mm-gold tracking-tight" data-testid="r2-countdown-timer">
            {displayTime}s
          </div>

          <div className="mt-8 text-xs font-mono text-mm-text2">
            Duration: 120 seconds · Decision & Explanation required together
          </div>
        </div>
      </Shell>
    );
  }

  // 3. QUESTION OPEN PHASE
  if (status.phase === "QUESTION" && status.question) {
    const q = status.question;
    const chartNum = (status.question_index ?? 0) + 1;
    const totalQ = status.total_questions ?? 5;
    const effectiveChoice = hasAnswered ? lockedAnswer : pendingChoice;
    const effectiveExplanation = hasAnswered ? lockedExplanation : explanationDraft;

    return (
      <Shell>
        <div className="max-w-4xl mx-auto space-y-6" data-testid="r2-question-container">
          {/* Header Bar */}
          <div className="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-mm-border">
            <div>
              <div className="font-mono text-[11px] tracking-widest text-mm-gold">
                ROUND 02 · THE CALL · CHART {chartNum} / {totalQ}
              </div>
              <div className="font-serif text-2xl mt-1 text-mm-text flex items-center gap-3">
                <span>{q.asset || "MARKET SETUP"}</span>
                {q.timeframe && (
                  <span className="font-mono text-xs px-2 py-0.5 border border-mm-border text-mm-text2">
                    {q.timeframe}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right">
              <div className="font-mono text-[10px] tracking-widest text-mm-text2 uppercase">
                {isPaused ? "Status" : "Shared Clock"}
              </div>
              <div
                className={`font-mono text-3xl font-bold ${
                  isPaused ? "text-mm-gold" : displayTime <= 15 ? "text-mm-red animate-pulse" : "text-mm-gold"
                }`}
                data-testid="r2-timer"
              >
                {isPaused ? "PAUSED" : `${displayTime}s`}
              </div>
            </div>
          </div>

          {/* Pause Banner */}
          {isPaused && (
            <div className="p-4 border border-mm-gold bg-mm-gold/10 font-mono text-xs text-mm-gold mm-corner-ticks flex items-center justify-between">
              <span>⚠ ROUND 2 IS CURRENTLY PAUSED BY THE FLOOR CONTROLLER. CLOCKS AND SUBMISSIONS ARE FROZEN.</span>
              <span className="font-bold uppercase text-[10px] px-2 py-0.5 bg-mm-gold text-black">PAUSED</span>
            </div>
          )}

          {/* Chart Display Notice */}
          <div className="p-4 border border-mm-border bg-black/60 mm-corner-ticks font-mono text-xs text-mm-text2 flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-mm-gold animate-ping shrink-0" />
            <span>
              Observe <strong>Chart #{chartNum}</strong> on the auditorium screen. Formulate your decision and plain-text rationale below.
            </span>
          </div>

          {/* Question Text */}
          <div className="mm-panel mm-corner-ticks p-6">
            <div className="font-mono text-[10px] tracking-widest text-mm-text2 uppercase mb-2">Prompt</div>
            <h2 className="font-serif text-xl sm:text-2xl text-mm-text" data-testid="r2-question-text">
              {q.text}
            </h2>
          </div>

          {/* Decision Selection Grid */}
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="font-mono text-[11px] tracking-widest text-mm-gold uppercase">
                // Step 1: Select Team Decision
              </div>
              <div
                className={`font-mono text-xs px-2.5 py-1 rounded border flex items-center gap-2 ${
                  effectiveChoice
                    ? "border-mm-gold/60 bg-mm-gold/10 text-mm-gold"
                    : "border-mm-border text-mm-text2"
                }`}
                data-testid="r2-current-selection-badge"
              >
                <span>Active Decision:</span>
                <strong className={effectiveChoice ? "text-mm-text font-bold" : "text-mm-muted"}>
                  {effectiveChoice ? `Selected: ${effectiveChoice.replace("_", " ")}` : "None Selected"}
                </strong>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* BUY Button */}
              <button
                type="button"
                onClick={() => !hasAnswered && setPendingChoice("BUY")}
                disabled={hasAnswered || isPaused}
                aria-pressed={effectiveChoice === "BUY"}
                data-testid="r2-btn-buy"
                className={`r2-decision-btn mm-corner-ticks p-6 text-left transition-all ${
                  effectiveChoice === "BUY"
                    ? "is-selected-buy"
                    : "hover:border-mm-green/60"
                } ${hasAnswered && effectiveChoice !== "BUY" ? "opacity-30 cursor-not-allowed" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs tracking-widest text-mm-green font-bold">▲ LONG</span>
                  {effectiveChoice === "BUY" ? (
                    <span
                      className="font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-mm-green bg-mm-green/20 text-mm-green flex items-center gap-1.5"
                      data-testid="r2-selected-indicator-buy"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-mm-green animate-pulse" />
                      SELECTED: BUY
                    </span>
                  ) : (
                    <span className="font-mono text-[9px] text-mm-text2 uppercase tracking-wider">CLICK TO SELECT</span>
                  )}
                </div>
                <div className="font-serif text-3xl mt-2 text-mm-green font-bold">BUY</div>
                <div className="font-mono text-[10px] text-mm-text2 mt-1">Anticipate bullish expansion</div>
              </button>

              {/* SELL Button */}
              <button
                type="button"
                onClick={() => !hasAnswered && setPendingChoice("SELL")}
                disabled={hasAnswered || isPaused}
                aria-pressed={effectiveChoice === "SELL"}
                data-testid="r2-btn-sell"
                className={`r2-decision-btn mm-corner-ticks p-6 text-left transition-all ${
                  effectiveChoice === "SELL"
                    ? "is-selected-sell"
                    : "hover:border-mm-red/60"
                } ${hasAnswered && effectiveChoice !== "SELL" ? "opacity-30 cursor-not-allowed" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs tracking-widest text-mm-red font-bold">▼ SHORT</span>
                  {effectiveChoice === "SELL" ? (
                    <span
                      className="font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-mm-red bg-mm-red/20 text-mm-red flex items-center gap-1.5"
                      data-testid="r2-selected-indicator-sell"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-mm-red animate-pulse" />
                      SELECTED: SELL
                    </span>
                  ) : (
                    <span className="font-mono text-[9px] text-mm-text2 uppercase tracking-wider">CLICK TO SELECT</span>
                  )}
                </div>
                <div className="font-serif text-3xl mt-2 text-mm-red font-bold">SELL</div>
                <div className="font-mono text-[10px] text-mm-text2 mt-1">Anticipate bearish breakdown</div>
              </button>

              {/* NO TRADE Button */}
              <button
                type="button"
                onClick={() => !hasAnswered && setPendingChoice("NO_TRADE")}
                disabled={hasAnswered || isPaused}
                aria-pressed={effectiveChoice === "NO_TRADE"}
                data-testid="r2-btn-notrade"
                className={`r2-decision-btn mm-corner-ticks p-6 text-left transition-all ${
                  effectiveChoice === "NO_TRADE"
                    ? "is-selected-notrade"
                    : "hover:border-mm-gold/60"
                } ${hasAnswered && effectiveChoice !== "NO_TRADE" ? "opacity-30 cursor-not-allowed" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs tracking-widest text-mm-gold font-bold">— SIT OUT</span>
                  {effectiveChoice === "NO_TRADE" ? (
                    <span
                      className="font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-mm-gold bg-mm-gold/20 text-mm-gold flex items-center gap-1.5"
                      data-testid="r2-selected-indicator-notrade"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-mm-gold animate-pulse" />
                      SELECTED: NO TRADE
                    </span>
                  ) : (
                    <span className="font-mono text-[9px] text-mm-text2 uppercase tracking-wider">CLICK TO SELECT</span>
                  )}
                </div>
                <div className="font-serif text-3xl mt-2 text-mm-gold font-bold">NO TRADE</div>
                <div className="font-mono text-[10px] text-mm-text2 mt-1">Chop / Low-probability setup</div>
              </button>
            </div>
          </div>

          {/* Explanation Input (Mandatory, 1 line, max 250 characters) */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <label htmlFor="r2-explanation-input" className="font-mono text-[11px] tracking-widest text-mm-gold uppercase">
                // Step 2: Decision Rationale (Mandatory · Single Line)
              </label>
              <span
                className={`font-mono text-xs ${
                  effectiveExplanation.length > 240 ? "text-mm-red" : "text-mm-text2"
                }`}
                data-testid="r2-char-counter"
              >
                {effectiveExplanation.length} / 250
              </span>
            </div>

            <input
              id="r2-explanation-input"
              type="text"
              maxLength={250}
              disabled={hasAnswered || isPaused}
              value={effectiveExplanation}
              onChange={(e) => {
                // Prevent multi-line input
                const singleLine = e.target.value.replace(/[\r\n]+/g, " ");
                setExplanationDraft(singleLine);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!hasAnswered && pendingChoice && explanationDraft.trim()) {
                    submitDecision();
                  }
                }
              }}
              placeholder="e.g., Bearish fair-value gap retest with strong displacement below key support."
              data-testid="r2-input-explanation"
              className="w-full px-4 py-3.5 bg-black/50 border border-mm-border focus:border-mm-gold font-mono text-sm text-mm-text disabled:opacity-60"
            />
          </div>

          {/* Submit Decision Button */}
          <div className="pt-2">
            {hasAnswered ? (
              <div
                className="p-4 border border-mm-green bg-mm-green/10 text-center mm-corner-ticks font-mono text-sm text-mm-green flex items-center justify-center gap-3"
                data-testid="r2-locked-banner"
              >
                <span className="w-2 h-2 rounded-full bg-mm-green" />
                <span>Decision Locked: <strong>{lockedAnswer}</strong> · Waiting for chart countdown to conclude.</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={submitDecision}
                disabled={!pendingChoice || !explanationDraft.trim() || submitting || isPaused || displayTime === 0}
                data-testid="r2-btn-submit"
                className="w-full py-4 btn-primary font-mono text-base tracking-widest uppercase disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Transmitting Decision…" : "Submit Decision"}
              </button>
            )}
          </div>

          {/* Score so far */}
          <div className="pt-4 flex items-center justify-between text-xs font-mono text-mm-text2 border-t border-mm-border">
            <span>Score so far: <strong className="text-mm-text">{status.standings?.round2 ?? status.team_score ?? 0} pts</strong></span>
            <span>1 Point per correct BUY/SELL · 0 Points for wrong or NO TRADE</span>
          </div>
        </div>
      </Shell>
    );
  }

  // 4. RESULT PHASE
  if (status.phase === "RESULT" && status.question) {
    const q = status.question;
    const sub = status.team_submission;
    const chartNum = (status.question_index ?? 0) + 1;
    const isCorrect = Boolean(sub?.correct);
    const correctAns = q.correct_answer;

    return (
      <Shell>
        <div className="max-w-4xl mx-auto space-y-6" data-testid="r2-result-screen">
          <div className="flex items-center justify-between pb-4 border-b border-mm-border">
            <div>
              <div className="font-mono text-[11px] tracking-widest text-mm-gold">
                ROUND 02 · CHART {chartNum} REVEAL
              </div>
              <h2 className="font-serif text-3xl mt-1 text-mm-text">Official Outcome</h2>
            </div>
            <div className="text-right">
              <div className="font-mono text-[10px] tracking-widest text-mm-text2 uppercase">Next Chart In</div>
              <div className="font-mono text-2xl font-bold text-mm-gold" data-testid="r2-result-timer">
                {displayTime}s
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            {/* Correct Official Decision */}
            <div className="mm-panel mm-corner-ticks p-6 border-mm-gold/40">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-gold">Official Decision</div>
              <div className="font-serif text-4xl mt-3 text-mm-text flex items-center gap-3" data-testid="r2-correct-answer">
                <span>{correctAns}</span>
                <span className={`text-xs font-mono px-2 py-0.5 border ${
                  correctAns === "BUY" ? "border-mm-green text-mm-green" : "border-mm-red text-mm-red"
                }`}>
                  {correctAns === "BUY" ? "▲ BULLISH" : "▼ BEARISH"}
                </span>
              </div>
              <div className="font-mono text-xs text-mm-text2 mt-3">{q.text}</div>
            </div>

            {/* Team Result Card */}
            <div className={`mm-panel mm-corner-ticks p-6 ${
              !sub?.answered ? "border-mm-border" : isCorrect ? "border-mm-green bg-mm-green/5" : "border-mm-red bg-mm-red/5"
            }`}>
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Your Desk Result</div>
              {sub?.answered ? (
                <>
                  <div className="flex items-center justify-between mt-3">
                    <div className="font-serif text-3xl font-bold text-mm-text">
                      {sub.answer}
                    </div>
                    <div className={`font-mono text-2xl font-bold ${isCorrect ? "text-mm-green" : "text-mm-red"}`} data-testid="r2-result-points">
                      {isCorrect ? "+1 Pt" : "0 Pts"}
                    </div>
                  </div>
                  {sub.explanation && (
                    <div className="mt-4 pt-3 border-t border-mm-border/60">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2 mb-1">Submitted Rationale</div>
                      <div className="font-mono text-xs text-mm-text italic">
                        "{sub.explanation}"
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-4 font-mono text-sm text-mm-text2">
                  No decision submitted before the deadline (0 Pts).
                </div>
              )}
            </div>
          </div>

          {/* Current cumulative Round 2 score */}
          <div className="p-4 bg-mm-panel/50 border border-mm-border flex items-center justify-between font-mono text-sm">
            <span className="text-mm-text2">Current Round 2 Score</span>
            <span className="text-xl text-mm-gold font-bold" data-testid="r2-current-score">
              {status.standings?.round2 ?? status.team_score ?? 0} pts
            </span>
          </div>

          {/* Floor Leaderboard */}
          {Array.isArray(status.leaderboard) && status.leaderboard.length > 0 && (
            <div className="mm-panel mm-corner-ticks p-6 mt-6">
              <div className="font-mono text-[11px] tracking-widest text-mm-gold mb-4">
                // FLOOR STANDINGS (TOP 10)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-mm-text2 border-b border-mm-border pb-2">
                      <th className="py-2">Rank</th>
                      <th className="py-2">Team</th>
                      <th className="py-2 text-right">R2 Score</th>
                      <th className="py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.leaderboard.map((r) => (
                      <tr key={r.team_id} className="border-b border-mm-border/40 py-1.5">
                        <td className="py-2 text-mm-gold font-bold">#{r.rank}</td>
                        <td className="py-2 text-mm-text">{r.team_name}</td>
                        <td className="py-2 text-right font-mono">{r.round2}</td>
                        <td className="py-2 text-right font-mono font-bold text-mm-text">{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // 5. COMPLETED PHASE
  if (status.phase === "COMPLETED" || status.status === "COMPLETED") {
    const totalQ = status.total_questions || 5;
    return (
      <Shell>
        <div className="mm-panel mm-corner-ticks p-8 sm:p-12 max-w-2xl mx-auto text-center" data-testid="r2-completed-screen">
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 02 · COMPLETE</div>
          <h1 className="font-serif text-4xl sm:text-5xl mt-4">The Call has concluded.</h1>
          <p className="text-mm-text2 mt-4 font-mono text-sm max-w-lg mx-auto">
            All 5 market charts have closed. Final scores have been integrated into floor standings.
          </p>

          <div className="font-mono text-6xl mt-8 text-mm-green font-bold" data-testid="r2-final-score">
            {status.standings?.round2 ?? status.team_score ?? 0} <span className="text-2xl text-mm-text2">/ {totalQ} pts</span>
          </div>

          <div className="mt-10 flex items-center justify-center gap-4">
            <Link to="/dashboard" className="btn-primary px-8 py-3 font-mono text-sm tracking-widest uppercase" data-testid="r2-complete-dashboard-btn">
              Back to Dashboard
            </Link>
            <Link to="/leaderboard" className="btn-ghost px-8 py-3 font-mono text-sm tracking-widest uppercase">
              View Leaderboard
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  return null;
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-5xl mx-auto px-6 py-12">{children}</div>
    </div>
  );
}

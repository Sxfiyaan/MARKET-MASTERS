import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Nav from "@/components/Nav";
import { api, formatApiError } from "@/lib/api";
import { toast } from "sonner";
import { Link } from "react-router-dom";

export default function Round1() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pendingChoice, setPendingChoice] = useState(null);

  // Local display seconds remaining for the current phase
  const [displayTime, setDisplayTime] = useState(0);

  // Refs for tracking timer, transition requests, and sequence numbers
  const statusRef = useRef(null);
  statusRef.current = status;

  const deadlineRequestedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(null);

  const serverTimeOffsetRef = useRef(0);
  const statusRequestIdRef = useRef(0);

  // Fetch status from server with overlapping response protection
  const fetchStatus = useCallback(async (isDeadlineTrigger = false) => {
    const reqId = ++statusRequestIdRef.current;
    try {
      const { data } = await api.get("/rounds/1/status");

      // Discard older overlapping responses that resolved out of order
      if (reqId !== statusRequestIdRef.current) {
        return null;
      }

      const prev = statusRef.current;

      // Discard backward server-time jumps
      if (prev?.server_time && data?.server_time) {
        if (new Date(data.server_time).getTime() < new Date(prev.server_time).getTime()) {
          return prev;
        }
      }

      setStatus(data);
      setLoading(false);

      if (data?.server_time) {
        const serverTimeMs = new Date(data.server_time).getTime();
        serverTimeOffsetRef.current = serverTimeMs - Date.now();
      }

      // Check if phase changed or question advanced
      const phaseChanged = !prev || prev.phase !== data.phase || prev.question_index !== data.question_index;

      if (phaseChanged) {
        deadlineRequestedRef.current = false;
        retryCountRef.current = 0;
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        setPendingChoice(null);
      } else if (isDeadlineTrigger) {
        // If deadline was triggered but phase hasn't transitioned yet (clock skew), bounded retry
        if (retryCountRef.current < 4) {
          retryCountRef.current += 1;
          const delay = retryCountRef.current * 700;
          retryTimerRef.current = setTimeout(() => {
            fetchStatus(true);
          }, delay);
        }
      }
      return data;
    } catch (e) {
      setLoading(false);
      return null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Modest backup status check every 3.5s to catch pause/resume and external state changes
  useEffect(() => {
    const backupInterval = setInterval(() => {
      fetchStatus(false);
    }, 3500);
    return () => clearInterval(backupInterval);
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
    if (!phaseEndsAt && !isPaused) {
      setDisplayTime(0);
      return;
    }

    if (isPaused) {
      setDisplayTime(statusTimeLeft ?? 0);
      return;
    }

    const calcRemaining = () => {
      const endsAtMs = new Date(phaseEndsAt).getTime();
      const estimatedServerNow = Date.now() + (serverTimeOffsetRef.current || 0);
      return Math.max(0, Math.ceil((endsAtMs - estimatedServerNow) / 1000));
    };

    setDisplayTime(calcRemaining());

    const tickInterval = setInterval(() => {
      if (statusRef.current?.is_paused) return;

      const remainingSec = calcRemaining();
      setDisplayTime(remainingSec);

      // When the display timer hits zero, trigger exactly ONE deadline status request
      if (remainingSec === 0 && !deadlineRequestedRef.current) {
        deadlineRequestedRef.current = true;
        fetchStatus(true);
      }
    }, 500);

    return () => clearInterval(tickInterval);
  }, [phaseEndsAt, isPaused, statusTimeLeft, fetchStatus]);

  // Answer submission: robust confirmation with server reconciliation and retry support
  const submitAnswer = useCallback(async (letter) => {
    if (!status || status.phase !== "QUESTION" || !status.question || submitting) return;
    if (status.team_submission?.answered) return;
    if (status.is_paused) {
      toast.error("Round 1 is currently paused.");
      return;
    }

    const targetQuestionId = status.question.id;
    setSubmitting(true);
    setPendingChoice(letter);

    try {
      const { data } = await api.post("/rounds/1/submit", {
        question_id: targetQuestionId,
        answer: letter,
      });

      // Late acknowledgement guard: Ensure question has not progressed to Q2 before marking answered
      setStatus((prev) => {
        if (!prev || prev.question?.id !== targetQuestionId) {
          // Question advanced while request was in-flight; do NOT mark new question answered!
          return prev;
        }
        return {
          ...prev,
          team_submission: {
            answered: true,
            answer: data?.answer || letter,
            submitted_at: new Date().toISOString(),
          },
        };
      });

      toast.success("Answer locked in!");
    } catch (e) {
      // Reconcile with server to verify if answer was recorded (e.g. by teammate or connection drop)
      const freshStatus = await fetchStatus(false);
      if (freshStatus?.team_submission?.answered) {
        toast.info("Answer was locked in by a teammate.");
      } else {
        // Request failed and no answer exists on server: allow player to retry!
        setPendingChoice(null);
        toast.error(formatApiError(e) || "Submission failed. Please select your answer again.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [status, submitting, fetchStatus]);

  // Confirmed team submission answer
  const hasAnswered = Boolean(status?.team_submission?.answered);
  const lockedAnswer = status?.team_submission?.answer || (submitting ? pendingChoice : null);

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

  // 1. WAITING ROOM (Round 1 is UPCOMING or WAITING)
  if (!status || status.phase === "WAITING" || status.status === "IDLE") {
    return (
      <Shell>
        <div className="mm-panel mm-corner-ticks p-8 sm:p-12 max-w-2xl mx-auto" data-testid="r1-waiting-room">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 01 · WAITING ROOM</div>
            <span className="font-mono text-[10px] tracking-widest px-2.5 py-1 border border-mm-gold/40 text-mm-gold">
              STANDBY
            </span>
          </div>

          <h1 className="font-serif text-4xl sm:text-5xl mt-5">The floor is preparing.</h1>
          <p className="text-mm-text2 mt-4 font-mono text-sm leading-relaxed">
            All teams will begin Round 1 simultaneously. When the floor director activates the quiz, every trading desk will receive a synchronized 10-second countdown.
          </p>

          <div className="grid grid-cols-2 gap-4 mt-8 pt-8 border-t border-mm-border">
            <div className="p-4 bg-mm-panel/50 border border-mm-border">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Question Set</div>
              <div className="font-mono text-2xl mt-1 text-mm-text" data-testid="r1-total-questions">
                {status?.total_questions ? `${status.total_questions} Questions` : "20–30 Questions"}
              </div>
            </div>
            <div className="p-4 bg-mm-panel/50 border border-mm-border">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mm-text2">Rules</div>
              <div className="font-mono text-sm mt-1 text-mm-gold">1 Answer / Team</div>
            </div>
          </div>

          <div className="mt-10 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-mm-text2">
              <span className="w-2 h-2 rounded-full bg-mm-green animate-pulse" />
              Connected to floor controller
            </div>
            <Link to="/dashboard" className="btn-ghost" data-testid="r1-back-dashboard">
              Back to Dashboard
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  // 2. SHARED COUNTDOWN (10 seconds before Question 1)
  if (status.phase === "COUNTDOWN") {
    return (
      <Shell>
        <div className="mm-panel mm-corner-ticks p-8 sm:p-14 max-w-xl mx-auto text-center" data-testid="r1-countdown-screen">
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold uppercase">// ROUND 01 · SYNCHRONIZING</div>
          <h1 className="font-serif text-4xl sm:text-5xl mt-3">Get Ready.</h1>
          <p className="text-mm-text2 mt-3 font-mono text-xs tracking-wider">
            Round 1 starts in all trading desks simultaneously.
          </p>

          <div className="my-10">
            <div className="font-mono text-7xl sm:text-8xl text-mm-gold tracking-tight" data-testid="r1-starting-countdown">
              {String(displayTime).padStart(2, "0")}
            </div>
            <div className="font-mono text-xs tracking-widest text-mm-text2 mt-2">SECONDS UNTIL QUESTION 1</div>
          </div>

          <div className="h-1 bg-mm-border overflow-hidden">
            <div
              className="h-full bg-mm-gold transition-all duration-500 ease-linear"
              style={{ width: `${Math.min(100, (displayTime / (status.countdown_seconds || 10)) * 100)}%` }}
            />
          </div>

          {status.is_paused && <PauseBanner timeLeft={displayTime} />}
        </div>
      </Shell>
    );
  }

  // 3. COMPLETION SCREEN
  if (status.phase === "COMPLETED" || (status.round_state === "COMPLETED" && status.phase !== "RESULT")) {
    return (
      <Shell>
        <div className="mm-panel mm-corner-ticks p-8 sm:p-12 max-w-2xl mx-auto text-center" data-testid="r1-complete-screen">
          <div className="font-mono text-[11px] tracking-[0.3em] text-mm-gold">// ROUND 01 COMPLETE</div>
          <h1 className="font-serif text-5xl mt-4">The quiz has concluded.</h1>
          <p className="text-mm-text2 font-mono text-sm mt-3">
            All questions for Round 1 have closed. Your team's performance has been recorded.
          </p>

          <div className="grid grid-cols-2 gap-4 mt-8 p-6 bg-mm-panel/60 border border-mm-border">
            <div>
              <div className="font-mono text-[10px] tracking-widest text-mm-text2 uppercase">Final R1 Score</div>
              <div className="font-mono text-4xl mt-2 text-mm-green" data-testid="r1-final-score">
                {status.team_score ?? 0} pts
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] tracking-widest text-mm-text2 uppercase">Current Rank</div>
              <div className="font-mono text-4xl mt-2 text-mm-gold" data-testid="r1-final-rank">
                {status.standings?.rank ? `#${status.standings.rank}` : "–"}
              </div>
            </div>
          </div>

          <div className="mt-10">
            <Link to="/dashboard" data-testid="r1-back-dashboard" className="btn-primary inline-block">
              Return to Dashboard
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  // 4. RESULT PHASE (10 seconds after question closes with full agreed leaderboard)
  if (status.phase === "RESULT") {
    const q = status.question;
    const sub = status.team_submission;
    const isCorrect = Boolean(sub?.correct);
    const didAnswer = Boolean(sub?.answered);
    const pts = sub?.score || 0;
    const leaderboard = status.leaderboard || [];

    return (
      <Shell>
        {status.is_paused && <PauseBanner timeLeft={displayTime} />}

        <div className="flex items-center justify-between border-b border-mm-border pb-4" data-testid="r1-result-screen">
          <div className="font-mono text-[11px] tracking-widest text-mm-gold">
            // QUESTION {Number(status.question_index) + 1} OF {status.total_questions} · RESULT
          </div>
          <div className="font-mono text-[11px] tracking-widest">
            NEXT QUESTION IN{" "}
            <span className="text-mm-gold font-bold" data-testid="r1-result-countdown">
              {displayTime}s
            </span>
          </div>
        </div>

        <div className="mt-6 h-1 bg-mm-panel">
          <div
            className="h-full bg-mm-gold transition-all duration-300"
            style={{ width: `${Math.min(100, (displayTime / (status.result_seconds || 10)) * 100)}%` }}
          />
        </div>

        {/* Result Outcome Card */}
        <div className="mm-panel mm-corner-ticks p-6 sm:p-8 mt-8">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="font-mono text-[10px] tracking-widest uppercase text-mm-text2">Outcome</div>
              <div className="font-serif text-3xl mt-1">
                {didAnswer ? (
                  isCorrect ? (
                    <span className="text-mm-green" data-testid="r1-result-correct">Correct · +{pts} pts</span>
                  ) : (
                    <span className="text-mm-red" data-testid="r1-result-incorrect">Incorrect · +0 pts</span>
                  )
                ) : (
                  <span className="text-mm-text2" data-testid="r1-result-no-answer">Time Expired (No Answer) · +0 pts</span>
                )}
              </div>
            </div>

            <div className="flex gap-4">
              <div className="px-4 py-2 border border-mm-border bg-mm-panel">
                <div className="font-mono text-[9px] uppercase tracking-widest text-mm-text2">Team Score</div>
                <div className="font-mono text-xl text-mm-text" data-testid="r1-result-team-score">
                  {status.team_score ?? 0}
                </div>
              </div>
              {status.standings?.rank && (
                <div className="px-4 py-2 border border-mm-border bg-mm-panel">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-mm-text2">Floor Rank</div>
                  <div className="font-mono text-xl text-mm-gold" data-testid="r1-result-rank">
                    #{status.standings.rank}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-mm-border">
            <div className="font-serif text-2xl text-mm-text leading-snug">{q?.text}</div>

            <div className="grid sm:grid-cols-2 gap-3 mt-6">
              {["A", "B", "C", "D"].map((L, i) => {
                const optText = q?.options?.[i];
                if (!optText) return null;
                const isCorrectAnswer = q?.correct_answer === L;
                const isTeamChoice = sub?.answer === L;

                let borderCls = "border-mm-border";
                let badge = null;

                if (isCorrectAnswer) {
                  borderCls = "border-mm-green bg-mm-green/10";
                  badge = <span className="font-mono text-[9px] px-1.5 py-0.5 bg-mm-green text-black uppercase">Correct Answer</span>;
                } else if (isTeamChoice && !isCorrect) {
                  borderCls = "border-mm-red bg-mm-red/10";
                  badge = <span className="font-mono text-[9px] px-1.5 py-0.5 bg-mm-red text-white uppercase">Your Answer</span>;
                }

                return (
                  <div key={L} className={`p-4 border ${borderCls} flex items-start justify-between gap-3`}>
                    <div className="flex items-start gap-3">
                      <span className="font-mono font-bold text-mm-gold">{L}</span>
                      <span className="text-sm text-mm-text">{optText}</span>
                    </div>
                    {badge}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Agreed Floor Leaderboard Table */}
        {leaderboard.length > 0 && (
          <div className="mm-panel mm-corner-ticks p-6 sm:p-8 mt-8" data-testid="r1-result-leaderboard">
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-xs text-mm-gold tracking-widest uppercase">// CURRENT FLOOR STANDINGS</div>
              <div className="font-mono text-[10px] text-mm-text2 tracking-wider">REFRESHED AT DEADLINE</div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-mm-border text-mm-text2 uppercase tracking-widest text-[9px]">
                    <th className="py-2 px-3">Rank</th>
                    <th className="py-2 px-3">Desk / Team</th>
                    <th className="py-2 px-3">College</th>
                    <th className="py-2 px-3 text-right">R1 Points</th>
                    <th className="py-2 px-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-mm-border/40">
                  {leaderboard.map((row) => {
                    const isMyTeam = status.standings?.rank === row.rank;
                    return (
                      <tr
                        key={row.team_id || row.rank}
                        className={isMyTeam ? "bg-mm-gold/10 text-mm-gold font-bold" : "text-mm-text hover:bg-mm-panel/40"}
                      >
                        <td className="py-2 px-3">#{row.rank}</td>
                        <td className="py-2 px-3 flex items-center gap-2">
                          <span>{row.team_name}</span>
                          {isMyTeam && (
                            <span className="text-[8px] px-1 py-0.5 bg-mm-gold text-black uppercase font-bold">
                              Your Desk
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-mm-text2">{row.college}</td>
                        <td className="py-2 px-3 text-right font-mono">{row.round1 ?? 0}</td>
                        <td className="py-2 px-3 text-right font-mono text-mm-gold">{row.total ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between text-xs font-mono text-mm-text2">
          <span>Speed Factor scoring applied on server</span>
          <span>Next question opens automatically</span>
        </div>
      </Shell>
    );
  }

  // 5. ACTIVE QUESTION PHASE
  const curQ = status.question;
  const letters = ["A", "B", "C", "D"];
  const totalLimit = curQ?.time_limit || 30;

  return (
    <Shell>
      {status.is_paused && <PauseBanner timeLeft={displayTime} />}

      <div className="flex items-center justify-between" data-testid="r1-question-screen">
        <div className="font-mono text-[11px] tracking-widest text-mm-text2">
          QUESTION {Number(status.question_index) + 1} / {status.total_questions}
        </div>
        <div className="font-mono text-[11px] tracking-widest">
          TIME{" "}
          <span
            className={displayTime < 10 ? "text-mm-red font-bold animate-pulse" : "text-mm-gold font-bold"}
            data-testid="r1-timer"
          >
            {displayTime}s
          </span>
        </div>
      </div>

      <div className="mt-4 h-1 bg-mm-panel">
        <div
          className={`h-full transition-all duration-300 ${displayTime < 10 ? "bg-mm-red" : "bg-mm-gold"}`}
          style={{ width: `${Math.min(100, (displayTime / totalLimit) * 100)}%` }}
        />
      </div>

      <h2 className="font-serif text-3xl sm:text-4xl mt-10 leading-tight" data-testid="r1-question-text">
        {curQ?.text}
      </h2>

      {/* Locked-in answer banner */}
      {hasAnswered && (
        <div
          className="mt-6 p-4 border border-mm-gold/40 bg-mm-gold/5 flex items-center justify-between flex-wrap gap-3"
          data-testid="r1-locked-banner"
        >
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-mm-gold animate-pulse" />
            <span className="font-mono text-xs text-mm-text">
              Answer locked in (<span className="text-mm-gold font-bold">Option {lockedAnswer}</span>). Waiting for shared deadline…
            </span>
          </div>
          <span className="font-mono text-[10px] text-mm-text2 tracking-widest">
            {displayTime}s REMAINING
          </span>
        </div>
      )}

      {/* Options grid */}
      <div className="grid sm:grid-cols-2 gap-4 mt-8">
        {(curQ?.options || []).map((opt, i) => {
          const L = letters[i];
          const isSelected = lockedAnswer === L;

          let btnClass = "mm-panel mm-corner-ticks p-5 text-left transition";
          if (isSelected) {
            btnClass += " border-mm-gold bg-mm-gold/10";
          } else if (hasAnswered) {
            btnClass += " opacity-40 cursor-not-allowed";
          } else {
            btnClass += " hover:border-mm-gold";
          }

          return (
            <button
              key={L}
              onClick={() => submitAnswer(L)}
              disabled={hasAnswered || submitting || displayTime === 0 || status.is_paused}
              data-testid={`r1-option-${L}`}
              className={btnClass}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-4">
                  <div className="font-mono text-mm-gold text-2xl">{L}</div>
                  <div className="text-mm-text mt-1">{opt}</div>
                </div>
                {isSelected && (
                  <span className="font-mono text-[9px] px-2 py-0.5 bg-mm-gold text-black uppercase font-bold tracking-wider">
                    Desk Choice
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-10 flex items-center justify-between flex-wrap gap-4 pt-6 border-t border-mm-border">
        <div className="font-mono text-xs text-mm-text2">
          SCORE SO FAR · <span className="text-mm-text font-bold" data-testid="r1-running-score">{status.team_score ?? 0}</span>
        </div>
        <div className="font-mono text-xs text-mm-text2">
          {hasAnswered ? "Answer submitted · Stand by for result phase" : "Any teammate may answer · First response counts"}
        </div>
      </div>
    </Shell>
  );
}

function PauseBanner({ timeLeft }) {
  return (
    <div
      className="mb-8 p-4 border-2 border-mm-gold bg-black/90 mm-corner-ticks flex items-center justify-between flex-wrap gap-4 shadow-2xl"
      data-testid="r1-pause-banner"
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-lg text-mm-gold font-bold">⏸</span>
        <div>
          <div className="font-mono text-xs text-mm-gold font-bold tracking-widest uppercase">Round 1 Paused by Floor Director</div>
          <div className="font-mono text-[11px] text-mm-text2 mt-0.5">The countdown is frozen. Gameplay will resume automatically with remaining time.</div>
        </div>
      </div>
      <div className="font-mono text-xs px-3 py-1 bg-mm-panel border border-mm-gold text-mm-gold">
        FROZEN AT {timeLeft}s
      </div>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-mm-bg">
      <Nav />
      <div className="max-w-4xl mx-auto px-6 py-12">{children}</div>
    </div>
  );
}

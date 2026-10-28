import test from "node:test";
import assert from "node:assert/strict";

// Directly import production functions and HTTP handler from supabase/functions/market-api/index.ts
import {
  handle,
  all,
  computeScores,
  scores,
  getRound1State,
  saveRound1State,
  advanceRound1State,
  assertRound1NotActive,
  isQuestionClosed,
  setTestDb,
  invalidateConfigCache,
  invalidateLeaderboardCache,
  ApiError,
} from "../supabase/functions/market-api/index.ts";

/**
 * =============================================================================
 * TEST EXECUTION REALITY REPORT:
 * =============================================================================
 * 1. REAL PRODUCTION CODE EXERCISED:
 *    - All tests in this file import and execute the ACTUAL production implementation
 *      from `supabase/functions/market-api/index.ts` (`handle`, `computeScores`,
 *      `advanceRound1State`, `assertRound1NotActive`, `isQuestionClosed`, `saveRound1State`).
 *    - There are no rewritten handler duplicates.
 *
 * 2. DATABASE LAYER:
 *    - Uses an in-memory mock Supabase client adhering to the Supabase postgREST/RPC contract.
 *    - Tests DO NOT connect to the shared Supabase project.
 *
 * 3. RAW SQL ENGINE LAYER:
 *    - UNVERIFIED IN LIVE POSTGRESQL: Local Supabase CLI / isolated PostgreSQL was not
 *      installed in the host environment. The SQL migration `202610250007` is verified
 *      syntactically but remains unverified on a running PostgreSQL engine until applied
 *      in a dedicated local/staging database.
 * =============================================================================
 */

function createMockSupabase(initialData = {}) {
  const store = {
    round1_state: [
      {
        id: "current",
        version: 1,
        status: "IDLE",
        phase: "WAITING",
        current_question_index: 0,
        current_question_id: null,
        total_questions: 0,
        phase_start_at: null,
        phase_ends_at: null,
        is_paused: false,
        paused_at: null,
        pause_phase: null,
        paused_remaining_ms: 0,
        countdown_seconds: 10,
        result_seconds: 10,
        closed_question_ids: [],
        frozen_questions: null,
        speed_bonus_pct: 0.5,
        updated_at: new Date().toISOString(),
      },
    ],
    round2_state: [
      {
        id: "current",
        version: 1,
        status: "IDLE",
        phase: "WAITING",
        current_question_index: 0,
        current_question_id: null,
        total_questions: 0,
        phase_start_at: null,
        phase_ends_at: null,
        is_paused: false,
        paused_at: null,
        pause_phase: null,
        paused_remaining_ms: 0,
        countdown_seconds: 10,
        question_seconds: 120,
        result_seconds: 10,
        closed_question_ids: [],
        frozen_questions: null,
        updated_at: new Date().toISOString(),
      },
    ],
    event_config: [
      {
        id: "event",
        speed_bonus_pct: 0.5,
        registration_open: true,
        leaderboard_visible: true,
        trade_proof_required: false,
        results_finalized: false,
        performance_weight: 60,
        risk_mgmt_weight: 40,
        round1_weight: 30,
        round2_weight: 30,
        round3_weight: 40,
        rounds: {
          "1": { state: "UPCOMING", started_at: null, ended_at: null },
          "2": { state: "UPCOMING", started_at: null, ended_at: null },
          "3": { state: "UPCOMING", started_at: null, ended_at: null },
        },
      },
    ],
    questions: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        round: 1,
        text: "What does P/E stand for?",
        options: ["Price to Equity", "Price to Earnings", "Profit to Equity", "Performance to Earnings"],
        correct_answer: "B",
        base_points: 100,
        time_limit: 30,
        question_order: 1,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        round: 1,
        text: "What is beta in portfolio theory?",
        options: ["Volatility relative to benchmark", "Alpha excess", "Bond duration", "Dividend yield"],
        correct_answer: "A",
        base_points: 100,
        time_limit: 20,
        question_order: 2,
      },
    ],
    teams: [
      { id: "00000000-0000-0000-0000-000000000010", team_name: "Alpha Traders", college: "Wharton" },
      { id: "00000000-0000-0000-0000-000000000020", team_name: "Beta Bulls", college: "Harvard" },
    ],
    profiles: [
      { id: "user-alpha-1", email: "alpha1@test.com", name: "Alpha Leader", role: "team", team_id: "00000000-0000-0000-0000-000000000010" },
      { id: "user-alpha-2", email: "alpha2@test.com", name: "Alpha Mate", role: "team", team_id: "00000000-0000-0000-0000-000000000010" },
      { id: "user-admin", email: "admin@test.com", name: "Floor Director", role: "admin", team_id: null },
    ],
    submissions: [],
    trades: [],
    round3_sessions: [],
    score_overrides: [],
    leaderboard_snapshot: [],
    audit_logs: [],
    ...initialData,
  };

  const client = {
    auth: {
      getUser: async (token) => {
        const profile = store.profiles.find((p) => p.id === token || p.email === token);
        if (profile) return { data: { user: { id: profile.id, email: profile.email } }, error: null };
        return { data: { user: null }, error: new Error("Invalid session") };
      },
      admin: {
        createUser: async ({ email, password, email_confirm, user_metadata }) => {
          store._createdUsers = store._createdUsers || [];
          const newUser = { id: `auth-user-${Date.now()}-${Math.random()}`, email, user_metadata };
          store._createdUsers.push(newUser);
          return { data: { user: newUser }, error: null };
        },
        deleteUser: async (userId) => {
          if (store._createdUsers) {
            store._createdUsers = store._createdUsers.filter((u) => u.id !== userId);
          }
          return { data: { user: null }, error: null };
        },
      },
    },
    from: (table) => {
      let rows = store[table] || [];
      let filters = [];
      let updatePayload = null;
      let isInsert = false;
      let isDelete = false;
      let orderList = [];
      let rangeFrom = 0;
      let rangeTo = Infinity;

      const builder = {
        select: (cols = "*") => builder,
        eq: (col, val) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        neq: (col, val) => {
          filters.push((r) => r[col] !== val);
          return builder;
        },
        not: (col, op, val) => {
          if (op === "is" && val === null) {
            filters.push((r) => r[col] !== null);
          }
          return builder;
        },
        order: (col, opts = {}) => {
          if (table === "score_overrides" && col === "id") {
            throw new Error('column "id" does not exist in table score_overrides');
          }
          orderList.push([col, opts.ascending !== false]);
          return builder;
        },
        range: (from, to) => {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        insert: (vals) => {
          isInsert = true;
          const items = Array.isArray(vals) ? vals : [vals];
          for (const item of items) {
            const row = { ...item, id: item.id || `gen-${Date.now()}-${Math.random()}` };
            store[table].push(row);
          }
          return builder;
        },
        update: (vals) => {
          updatePayload = vals;
          return builder;
        },
        upsert: (vals) => {
          const items = Array.isArray(vals) ? vals : [vals];
          for (const item of items) {
            const idx = (store[table] || []).findIndex(
              (r) =>
                table === "score_overrides"
                  ? r.team_id === item.team_id && Number(r.round) === Number(item.round)
                  : r.id === item.id
            );
            if (idx >= 0) {
              store[table][idx] = { ...store[table][idx], ...item };
            } else {
              store[table] = store[table] || [];
              store[table].push({ ...item });
            }
          }
          return builder;
        },
        delete: () => {
          isDelete = true;
          return builder;
        },
        maybeSingle: async () => {
          if (updatePayload) {
            const matched = (store[table] || []).filter((r) => filters.every((f) => f(r)));
            if (!matched.length) return { data: null, error: null };
            for (const item of matched) {
              Object.assign(item, updatePayload);
            }
            return { data: { ...matched[0] }, error: null };
          }
          const matched = (store[table] || []).filter((r) => filters.every((f) => f(r)));
          return { data: matched.length ? { ...matched[0] } : null, error: null };
        },
        single: async () => {
          if (isInsert) {
            const last = store[table][store[table].length - 1];
            return { data: { ...last }, error: null };
          }
          return builder.maybeSingle();
        },
        then: (onResolve) => {
          if (updatePayload) {
            const matched = (store[table] || []).filter((r) => filters.every((f) => f(r)));
            for (const item of matched) {
              Object.assign(item, updatePayload);
            }
            return Promise.resolve(onResolve({ data: matched, error: null }));
          }
          if (isDelete) {
            store[table] = (store[table] || []).filter((r) => !filters.every((f) => f(r)));
            return Promise.resolve(onResolve({ data: null, error: null }));
          }
          let matched = (store[table] || []).filter((r) => filters.every((f) => f(r)));
          if (orderList.length) {
            matched = [...matched].sort((a, b) => {
              for (const [col, asc] of orderList) {
                const va = a[col] ?? "";
                const vb = b[col] ?? "";
                if (va !== vb) {
                  return asc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
                }
              }
              return 0;
            });
          }
          // Simulate API page limit / range slicing
          const maxLimit = store._simulatedRowLimit || Infinity;
          const effectiveTo = Math.min(rangeTo, rangeFrom + maxLimit - 1);
          const sliced = matched.slice(rangeFrom, effectiveTo + 1);
          return Promise.resolve(onResolve({ data: sliced.map((x) => ({ ...x })), error: null }));
        },
      };
      return builder;
    },
    rpc: async (fnName, params) => {
      if (store._simulatedRpcErrors?.[fnName]) {
        return { data: null, error: store._simulatedRpcErrors[fnName] };
      }

      const advancePhase = (nowMs) => {
        const state = store.round1_state.find((r) => r.id === "current");
        if (!state || state.is_paused || ["IDLE", "COMPLETED"].includes(state.status) || ["WAITING", "COMPLETED"].includes(state.phase)) {
          return state;
        }
        if (!state.phase_ends_at || nowMs < new Date(state.phase_ends_at).getTime()) {
          return state;
        }

        const qs = state.frozen_questions || store.questions;
        if (!qs.length) {
          state.status = "COMPLETED";
          state.phase = "COMPLETED";
          state.version += 1;
          return state;
        }

        let curEnds = new Date(state.phase_ends_at).getTime();
        let safety = 0;
        while (nowMs >= curEnds && safety < (qs.length * 2 + 5)) {
          safety++;
          if (state.phase === "COUNTDOWN") {
            state.phase = "QUESTION";
            state.status = "ACTIVE";
            state.current_question_index = 0;
            state.current_question_id = qs[0].id;
            state.phase_start_at = new Date(curEnds).toISOString();
            curEnds = curEnds + (qs[0].time_limit || 30) * 1000;
            state.phase_ends_at = new Date(curEnds).toISOString();
          } else if (state.phase === "QUESTION") {
            state.phase = "RESULT";
            if (state.current_question_id && !state.closed_question_ids.includes(state.current_question_id)) {
              state.closed_question_ids = [...state.closed_question_ids, state.current_question_id];
            }
            state.phase_start_at = new Date(curEnds).toISOString();
            curEnds = curEnds + (state.result_seconds || 10) * 1000;
            state.phase_ends_at = new Date(curEnds).toISOString();
          } else if (state.phase === "RESULT") {
            const nextIdx = state.current_question_index + 1;
            if (nextIdx < qs.length) {
              state.phase = "QUESTION";
              state.current_question_index = nextIdx;
              state.current_question_id = qs[nextIdx].id;
              state.phase_start_at = new Date(curEnds).toISOString();
              curEnds = curEnds + (qs[nextIdx].time_limit || 30) * 1000;
              state.phase_ends_at = new Date(curEnds).toISOString();
            } else {
              state.phase = "COMPLETED";
              state.status = "COMPLETED";
              state.current_question_id = null;
              state.phase_ends_at = null;
              store.event_config[0].rounds["1"].state = "COMPLETED";
              break;
            }
          } else {
            break;
          }
        }
        state.version += 1;
        state.updated_at = new Date(nowMs).toISOString();
        return state;
      };

      if (fnName === "advance_round1_state_tx") {
        const now = params?.p_now ? new Date(params.p_now).getTime() : Date.now();
        const state = advancePhase(now);
        return { data: { ...state }, error: null };
      }

      if (fnName === "submit_round1_answer") {
        const state = store.round1_state.find((r) => r.id === "current");
        const cfg = store.event_config.find((c) => c.id === "event");
        if (!state || state.is_paused || state.status !== "ACTIVE" || state.phase !== "QUESTION" || cfg?.rounds?.["1"]?.state !== "ACTIVE") {
          return { data: { ok: false, error: "Question is not currently open", code: "NOT_OPEN" }, error: null };
        }
        if (state.current_question_id !== params.p_question_id) {
          return { data: { ok: false, error: "Question is not currently active", code: "NOT_ACTIVE" }, error: null };
        }
        if (!state.phase_start_at || !state.phase_ends_at || new Date(state.phase_start_at) >= new Date(state.phase_ends_at)) {
          return { data: { ok: false, error: "Question timing is invalid or missing deadline", code: "INVALID_TIMING" }, error: null };
        }

        const now = Date.now();
        if (now >= new Date(state.phase_ends_at).getTime()) {
          return { data: { ok: false, error: "Question deadline has expired", code: "DEADLINE_EXPIRED" }, error: null };
        }

        const already = store.submissions.some((s) => s.team_id === params.p_team_id && s.question_id === params.p_question_id);
        if (already) {
          return { data: { ok: false, error: "Already submitted", code: "ALREADY_SUBMITTED" }, error: null };
        }

        const qs = state.frozen_questions || store.questions;
        const q = qs.find((item) => item.id === params.p_question_id);
        const correct = String(params.p_answer).toUpperCase() === String(q.correct_answer).toUpperCase();
        const subId = `sub-${Date.now()}`;
        store.submissions.push({
          id: subId,
          team_id: params.p_team_id,
          question_id: params.p_question_id,
          round: 1,
          answer: params.p_answer,
          correct,
          score: correct ? 100 : 0,
          time_taken: 5.0,
          submitted_at: new Date().toISOString(),
        });
        return { data: { ok: true, submission_id: subId, correct, score: correct ? 100 : 0, time_taken: 5.0 }, error: null };
      }

      if (fnName === "admin_stop_event_tx") {
        const now = params?.p_now ? new Date(params.p_now).getTime() : Date.now();
        advancePhase(now);
        store.event_config[0].rounds["1"].state = "COMPLETED";
        store.event_config[0].rounds["2"].state = "COMPLETED";
        store.event_config[0].rounds["3"].state = "COMPLETED";
        const state = store.round1_state.find((r) => r.id === "current");
        state.status = "COMPLETED";
        state.phase = "COMPLETED";
        state.is_paused = false;
        state.paused_remaining_ms = 0;
        state.version += 1;
        const r2State = store.round2_state.find((r) => r.id === "current");
        if (r2State) {
          r2State.status = "COMPLETED";
          r2State.phase = "COMPLETED";
          r2State.is_paused = false;
          r2State.paused_remaining_ms = 0;
          r2State.version += 1;
        }
        return { data: { ...state }, error: null };
      }

      if (fnName === "admin_reset_gameplay_tx") {
        store.submissions = [];
        store.trades = [];
        store.round3_sessions = [];
        store.score_overrides = [];
        store.leaderboard_snapshot = [];
        store.event_config[0].results_finalized = false;
        store.event_config[0].rounds["1"].state = "UPCOMING";
        store.event_config[0].rounds["2"].state = "UPCOMING";
        store.event_config[0].rounds["3"].state = "UPCOMING";
        const state = store.round1_state.find((r) => r.id === "current");
        state.status = "IDLE";
        state.phase = "WAITING";
        state.current_question_index = 0;
        state.current_question_id = null;
        state.closed_question_ids = [];
        state.frozen_questions = null;
        state.is_paused = false;
        state.paused_remaining_ms = 0;
        state.total_questions = store.questions.filter((q) => q.round === 1).length;
        state.version += 1;
        const r2State = store.round2_state.find((r) => r.id === "current");
        if (r2State) {
          r2State.status = "IDLE";
          r2State.phase = "WAITING";
          r2State.current_question_index = 0;
          r2State.current_question_id = null;
          r2State.closed_question_ids = [];
          r2State.frozen_questions = null;
          r2State.is_paused = false;
          r2State.paused_remaining_ms = 0;
          r2State.total_questions = store.questions.filter((q) => q.round === 2).length;
          r2State.version += 1;
        }
        return { data: { ...state }, error: null };
      }

      if (fnName === "admin_start_event_tx") {
        const state = store.round1_state.find((r) => r.id === "current");
        if (state && (["ACTIVE", "COUNTDOWN", "PAUSED"].includes(state.status) || state.is_paused)) {
          return { data: { ok: false, error: "Cannot start event while Round 1 is active or paused. Stop or reset the event first.", code: "R1_ACTIVE" }, error: null };
        }
        if (store.submissions.some((s) => s.round === 1)) {
          return { data: { ok: false, error: "Cannot start event when a played round exists. Reset gameplay first.", code: "ROUND_PLAYED" }, error: null };
        }
        store.event_config[0].registration_open = true;
        store.event_config[0].results_finalized = false;
        store.event_config[0].rounds["1"].state = "UPCOMING";
        store.event_config[0].rounds["2"].state = "UPCOMING";
        store.event_config[0].rounds["3"].state = "UPCOMING";
        return { data: { ok: true }, error: null };
      }

      if (fnName === "admin_finalize_results_tx") {
        const rounds = store.event_config[0].rounds;
        if (rounds["1"].state !== "COMPLETED" || rounds["2"].state !== "COMPLETED" || rounds["3"].state !== "COMPLETED") {
          return { data: { ok: false, error: "Cannot finalize results: all rounds must be completed first", code: "ROUNDS_NOT_COMPLETED" }, error: null };
        }
        const r1State = store.round1_state.find((r) => r.id === "current");
        if (r1State && (["ACTIVE", "COUNTDOWN", "PAUSED"].includes(r1State.status) || r1State.is_paused)) {
          return { data: { ok: false, error: "Cannot finalize results: Round 1 is still in progress", code: "R1_ACTIVE" }, error: null };
        }
        const r2State = store.round2_state.find((r) => r.id === "current");
        if (r2State && (["ACTIVE", "COUNTDOWN", "PAUSED"].includes(r2State.status) || r2State.is_paused)) {
          return { data: { ok: false, error: "Cannot finalize results: Round 2 is still in progress", code: "R2_ACTIVE" }, error: null };
        }
        const pending = store.trades.filter((t) => t.verification_status === "PENDING").length;
        if (pending > 0) {
          return { data: { ok: false, error: `Cannot finalize results: ${pending} trade verification(s) are pending review`, code: "PENDING_TRADES" }, error: null };
        }
        store.event_config[0].results_finalized = true;
        return { data: { ok: true, results_finalized: true }, error: null };
      }

      if (fnName === "admin_reopen_results_tx") {
        store.event_config[0].results_finalized = false;
        return { data: { ok: true, results_finalized: false }, error: null };
      }

      if (fnName === "admin_set_score_override_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before modifying scores.", code: "FINALIZED" }, error: null };
        }
        const existingIdx = store.score_overrides.findIndex((o) => o.team_id === params.p_team_id && o.round === params.p_round);
        const record = {
          team_id: params.p_team_id,
          round: params.p_round,
          new_score: params.p_new_score,
          reason: params.p_reason,
          updated_at: params.p_now || new Date().toISOString(),
        };
        if (existingIdx >= 0) {
          store.score_overrides[existingIdx] = record;
        } else {
          store.score_overrides.push(record);
        }
        return { data: { ok: true }, error: null };
      }

      if (fnName === "admin_verify_trade_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before modifying trades.", code: "FINALIZED" }, error: null };
        }
        const trade = store.trades.find((t) => t.id === params.p_trade_id);
        if (!trade) {
          return { data: { ok: false, error: "Trade not found", code: "NOT_FOUND" }, error: null };
        }
        trade.verification_status = params.p_status;
        trade.admin_notes = params.p_reason || null;
        return { data: { ok: true, trade: { ...trade } }, error: null };
      }

      if (fnName === "admin_delete_trade_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before deleting trades.", code: "FINALIZED" }, error: null };
        }
        const idx = store.trades.findIndex((t) => t.id === params.p_trade_id);
        if (idx < 0) {
          return { data: { ok: false, error: "Trade not found", code: "NOT_FOUND" }, error: null };
        }
        const [trade] = store.trades.splice(idx, 1);
        return { data: { ok: true, trade_id: trade.id, team_id: trade.team_id }, error: null };
      }

      if (fnName === "admin_delete_team_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before deleting teams.", code: "FINALIZED" }, error: null };
        }
        const idx = store.teams.findIndex((t) => t.id === params.p_team_id);
        if (idx < 0) {
          return { data: { ok: false, error: "Team not found", code: "NOT_FOUND" }, error: null };
        }
        const [team] = store.teams.splice(idx, 1);
        store.submissions = store.submissions.filter((s) => s.team_id !== team.id);
        store.trades = store.trades.filter((t) => t.team_id !== team.id);
        store.round3_sessions = store.round3_sessions.filter((s) => s.team_id !== team.id);
        store.score_overrides = store.score_overrides.filter((o) => o.team_id !== team.id);
        store.leaderboard_snapshot = store.leaderboard_snapshot.filter((l) => l.team_id !== team.id);
        return { data: { ok: true, owner_user_id: team.owner_user_id, team_name: team.team_name }, error: null };
      }

      if (fnName === "submit_round2_answer_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Submissions are closed.", code: "FINALIZED" }, error: null };
        }
        if (store.event_config[0].rounds["2"]?.state !== "ACTIVE") {
          return { data: { ok: false, error: "Round 2 is not active", code: "NOT_ACTIVE" }, error: null };
        }
        const question = store.questions.find((q) => q.id === params.p_question_id && q.round === 2);
        if (!question) {
          return { data: { ok: false, error: "Question not found", code: "NOT_FOUND" }, error: null };
        }
        const limit = Number(question.time_limit || 30);
        const timeTaken = Number(params.p_time_taken || 0);
        const speedFactor = Math.max(0, 1 - timeTaken / Math.max(1, limit));
        const correct = String(params.p_answer).toUpperCase() === String(question.correct_answer).toUpperCase();
        const score = correct ? Math.round(Number(question.base_points || 100) * (1 + 0.5 * speedFactor)) : 0;
        const subId = "sub-r2-" + Math.random().toString(36).slice(2);
        store.submissions.push({
          id: subId,
          team_id: params.p_team_id,
          question_id: params.p_question_id,
          round: 2,
          answer: params.p_answer,
          correct,
          score,
          time_taken: timeTaken,
          submitted_at: new Date().toISOString(),
        });
        return { data: { ok: true, submission_id: subId, correct, score }, error: null };
      }

      if (fnName === "submit_round3_trade_tx") {
        if (store.event_config[0].results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Submissions are closed.", code: "FINALIZED" }, error: null };
        }
        if (store.event_config[0].rounds["3"]?.state !== "ACTIVE") {
          return { data: { ok: false, error: "Round 3 is not active", code: "NOT_ACTIVE" }, error: null };
        }
        const session = store.round3_sessions.find((s) => s.team_id === params.p_team_id);
        if (!session) {
          return { data: { ok: false, error: "Start Round 3 first", code: "NO_SESSION" }, error: null };
        }
        if (new Date() >= new Date(session.ends_at) || session.closed) {
          return { data: { ok: false, error: "Round 3 window has closed", code: "SESSION_CLOSED" }, error: null };
        }
        const teamTrades = store.trades.filter((t) => t.team_id === params.p_team_id);
        const maxTrades = Number(store.event_config[0].max_trades || 2);
        if (teamTrades.length >= maxTrades) {
          return { data: { ok: false, error: "Trade limit reached", code: "TRADE_LIMIT" }, error: null };
        }
        const tradeNumber = teamTrades.length ? Math.max(...teamTrades.map((t) => Number(t.trade_number))) + 1 : 1;
        const trade = {
          id: "trade-" + Math.random().toString(36).slice(2),
          team_id: params.p_team_id,
          trade_number: tradeNumber,
          asset: params.p_asset,
          account_size: params.p_account_size,
          risk_per_trade: params.p_risk_per_trade,
          result_type: params.p_result_type,
          profit: params.p_profit,
          loss: params.p_loss,
          pl_percentage: params.p_pl_percentage,
          verification_status: "PENDING",
          admin_notes: null,
          proof_url: params.p_proof_url || null,
          submitted_at: new Date().toISOString(),
        };
        store.trades.push(trade);
        return { data: { ok: true, trade }, error: null };
      }

      if (fnName === "admin_set_round1_state_tx") {
        const now = params?.p_now ? new Date(params.p_now).getTime() : Date.now();
        advancePhase(now);
        const state = store.round1_state.find((r) => r.id === "current");
        const action = params?.p_action;
        if (action === "ACTIVE") {
          if (state.status === "COMPLETED" || state.phase === "COMPLETED") {
            return { data: { ok: false, error: "Round 1 is completed. To start a new run, perform an explicit Reset Gameplay first.", code: "ROUND_COMPLETED" }, error: null };
          }
          if (state.is_paused) {
            state.is_paused = false;
            state.status = state.pause_phase === "COUNTDOWN" ? "COUNTDOWN" : "ACTIVE";
            state.phase_ends_at = new Date(now + (state.paused_remaining_ms || 0)).toISOString();
            state.paused_remaining_ms = 0;
            state.pause_phase = null;
          } else {
            const qs = params?.p_frozen_questions || store.questions;
            if (!qs || !qs.length) {
              return { data: { ok: false, error: "No Round 1 questions configured", code: "NO_QUESTIONS" }, error: null };
            }
            state.status = "COUNTDOWN";
            state.phase = "COUNTDOWN";
            state.current_question_index = 0;
            state.current_question_id = qs[0]?.id;
            state.total_questions = qs.length;
            state.frozen_questions = qs;
            state.phase_start_at = new Date(now).toISOString();
            state.phase_ends_at = new Date(now + 10000).toISOString();
            state.closed_question_ids = [];
          }
          store.event_config[0].rounds["1"].state = "ACTIVE";
        } else if (action === "PAUSED") {
          if (["ACTIVE", "COUNTDOWN"].includes(state.status) && !state.is_paused) {
            state.is_paused = true;
            state.status = "PAUSED";
            state.pause_phase = state.phase;
            state.paused_remaining_ms = Math.max(0, new Date(state.phase_ends_at).getTime() - now);
          }
          store.event_config[0].rounds["1"].state = "PAUSED";
        } else if (action === "COMPLETED") {
          state.status = "COMPLETED";
          state.phase = "COMPLETED";
          state.is_paused = false;
          state.current_question_id = null;
          store.event_config[0].rounds["1"].state = "COMPLETED";
        } else if (action === "UPCOMING") {
          if (state.status === "COMPLETED" || (state.closed_question_ids && state.closed_question_ids.length > 0) || store.submissions.some((s) => s.round === 1)) {
            return { data: { ok: false, error: "Cannot return a played or completed round to UPCOMING. Perform an explicit Reset Gameplay first.", code: "ROUND_PLAYED" }, error: null };
          }
          state.status = "IDLE";
          state.phase = "WAITING";
          store.event_config[0].rounds["1"].state = "UPCOMING";
        }
        state.version += 1;
        state.updated_at = new Date(now).toISOString();
        return { data: { ok: true, state: { ...state }, round_value: { state: store.event_config[0].rounds["1"].state } }, error: null };
      }

      return { data: null, error: new Error(`Unknown RPC ${fnName}`) };
    },
  };

  return { client, store };
}

// =============================================================================
// PRODUCTION IMPLEMENTATION REGRESSION TESTS
// =============================================================================

test("1. Premature Score Visibility: computeScores and my-submissions mask paused questions and unfinished questions", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const r1 = store.round1_state[0];
  const q1Id = store.questions[0].id;

  // Question 1 is active, desk answers correctly
  r1.status = "ACTIVE";
  r1.phase = "QUESTION";
  r1.current_question_id = q1Id;
  r1.phase_start_at = new Date(Date.now() - 5000).toISOString();
  r1.phase_ends_at = new Date(Date.now() + 25000).toISOString();
  store.event_config[0].rounds["1"].state = "ACTIVE";

  store.submissions.push({
    id: "sub-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: q1Id,
    round: 1,
    answer: "B",
    correct: true,
    score: 140,
    time_taken: 5.0,
    submitted_at: new Date().toISOString(),
  });

  // Admin pauses Floor Director while Q1 is running
  r1.is_paused = true;
  r1.status = "PAUSED";
  r1.paused_remaining_ms = 25000;

  // (a) computeScores must NOT reveal Q1 score while paused (unclosed question!)
  const rows = await computeScores();
  const teamAlphaScore = rows.find((r) => r.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(teamAlphaScore.round1, 0, "Paused question score must NOT leak into leaderboard");

  // (b) /rounds/1/my-submissions must mask correct, score, and time_taken while paused
  const req = new Request("http://localhost/api/rounds/1/my-submissions", {
    headers: { authorization: "Bearer user-alpha-1" },
  });
  const res = await handle(req);
  assert.strictEqual(res.status, 200);
  const mySubs = await res.json();
  assert.strictEqual(mySubs.length, 1);
  assert.strictEqual(mySubs[0].correct, null, "correct must be masked for paused question");
  assert.strictEqual(mySubs[0].score, null, "score must be masked for paused question");
  assert.strictEqual(mySubs[0].time_taken, null, "time_taken must be masked for paused question");

  // (c) Manual completion while in QUESTION must NOT reveal unfinished question points
  r1.status = "COMPLETED";
  r1.phase = "COMPLETED";
  r1.is_paused = false;
  // q1Id is still NOT in closed_question_ids!
  const rowsAfterStop = await computeScores();
  const alphaScoreAfterStop = rowsAfterStop.find((r) => r.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(alphaScoreAfterStop.round1, 0, "Unfinished question points must NOT be revealed upon manual completion");
});

test("2. Admin Controls Consistency: Stop Event stops R1 and rejects subsequent submissions; blocks reopening without Reset", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Activate Round 1
  store.event_config[0].rounds["1"].state = "ACTIVE";
  store.round1_state[0].status = "ACTIVE";
  store.round1_state[0].phase = "QUESTION";
  store.round1_state[0].current_question_id = store.questions[0].id;
  store.round1_state[0].phase_start_at = new Date().toISOString();
  store.round1_state[0].phase_ends_at = new Date(Date.now() + 30000).toISOString();

  // (a) Admin hits Stop Event
  const stopReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "stop" }),
  });
  const stopRes = await handle(stopReq);
  assert.strictEqual(stopRes.status, 200);
  assert.strictEqual(store.round1_state[0].status, "COMPLETED", "Stop Event must set round1_state to COMPLETED");

  // (b) Subsequent submissions must be strictly rejected
  const submitReq = new Request("http://localhost/api/rounds/1/submit", {
    method: "POST",
    headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
    body: JSON.stringify({ question_id: store.questions[0].id, answer: "B" }),
  });
  await assert.rejects(
    async () => await handle(submitReq),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("not active")
  );

  // (c) ACTIVE must NOT restart a COMPLETED round
  const restartReq = new Request("http://localhost/api/rounds/1/state", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ state: "ACTIVE" }),
  });
  await assert.rejects(
    async () => await handle(restartReq),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Reset Gameplay first")
  );

  // (d) UPCOMING must NOT reopen a round that has existing submissions without Reset
  store.submissions.push({
    id: "sub-old",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 1,
    answer: "B",
    correct: true,
    score: 100,
  });
  store.round1_state[0].status = "IDLE"; // reset status only
  const reopenReq = new Request("http://localhost/api/rounds/1/state", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ state: "UPCOMING" }),
  });
  await assert.rejects(
    async () => await handle(reopenReq),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Perform an explicit Reset Gameplay first")
  );
});

test("3. Fresh Result Standings & Floor Leaderboard: Result screen delivers fresh standings and full floor leaderboard", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const r1 = store.round1_state[0];
  const q1Id = store.questions[0].id;
  store.event_config[0].rounds["1"].state = "ACTIVE";

  // Simulate Q1 moving to RESULT phase with q1Id in closed_question_ids
  r1.status = "ACTIVE";
  r1.phase = "RESULT";
  r1.current_question_id = q1Id;
  r1.closed_question_ids = [q1Id];
  r1.phase_start_at = new Date().toISOString();
  r1.phase_ends_at = new Date(Date.now() + 10000).toISOString();

  // Add submissions for both teams
  store.submissions.push(
    {
      id: "sub-1",
      team_id: "00000000-0000-0000-0000-000000000010",
      question_id: q1Id,
      round: 1,
      answer: "B",
      correct: true,
      score: 140,
      time_taken: 5.0,
      submitted_at: new Date().toISOString(),
    },
    {
      id: "sub-2",
      team_id: "00000000-0000-0000-0000-000000000020",
      question_id: q1Id,
      round: 1,
      answer: "A",
      correct: false,
      score: 0,
      time_taken: 10.0,
      submitted_at: new Date().toISOString(),
    }
  );

  // Fetch status during RESULT phase
  const statusReq = new Request("http://localhost/api/rounds/1/status", {
    headers: { authorization: "Bearer user-alpha-1" },
  });
  const res = await handle(statusReq);
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.phase, "RESULT");
  assert.strictEqual(data.team_submission.correct, true, "Correctness revealed in RESULT phase");
  assert.strictEqual(data.team_score, 140, "Team score reflects closed question points");

  // Verify full floor leaderboard is returned for the 10-second result screen
  assert.ok(Array.isArray(data.leaderboard), "Leaderboard array must be present in result status");
  assert.strictEqual(data.leaderboard.length, 2);
  assert.strictEqual(data.leaderboard[0].team_name, "Alpha Traders");
  assert.strictEqual(data.leaderboard[0].rank, 1);
  assert.strictEqual(data.leaderboard[0].round1, 140);
});

test("4. Question Set Freezing & Edit Lock Bypass Prevention: Changing round to 2 cannot bypass edit lock", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Activate Round 1
  store.event_config[0].rounds["1"].state = "ACTIVE";
  store.round1_state[0].status = "ACTIVE";
  store.round1_state[0].phase = "QUESTION";

  const q1Id = store.questions[0].id;

  // (a) Attempting to edit R1 question directly throws 400
  await assert.rejects(
    async () => await assertRound1NotActive(1, q1Id),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Cannot modify Round 1 questions")
  );

  // (b) Attempting to bypass by passing round: 2 in body MUST ALSO BE CAUGHT AND REJECTED!
  await assert.rejects(
    async () => await assertRound1NotActive(2, q1Id),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Cannot modify or reassign a Round 1 question")
  );
});

test("5. POST /rounds/1/submit HTTP handler returns ONLY acknowledgement and accepted answer (zero leak)", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Active question 1
  store.event_config[0].rounds["1"].state = "ACTIVE";
  const r1 = store.round1_state[0];
  r1.status = "ACTIVE";
  r1.phase = "QUESTION";
  r1.current_question_id = store.questions[0].id;
  r1.phase_start_at = new Date().toISOString();
  r1.phase_ends_at = new Date(Date.now() + 30000).toISOString();

  const req = new Request("http://localhost/api/rounds/1/submit", {
    method: "POST",
    headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
    body: JSON.stringify({ question_id: store.questions[0].id, answer: "B" }),
  });
  const res = await handle(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.answer, "B");
  assert.ok(body.submission_id);

  // CRITICAL: Zero leaks of correctness, score, or time_taken
  assert.strictEqual(body.correct, undefined, "correct must be undefined");
  assert.strictEqual(body.score, undefined, "score must be undefined");
  assert.strictEqual(body.time_taken, undefined, "time_taken must be undefined");
});

test("6. Stop/Reset Failure Safety: Reset RPC failure returns 500 error with zero writes/deletes and no success response", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Populate data that would be wiped on reset
  store.submissions.push({
    id: "sub-keep",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 1,
    answer: "B",
    correct: true,
    score: 100,
  });
  store.round1_state[0].status = "ACTIVE";
  store.event_config[0].rounds["1"].state = "ACTIVE";

  // Simulate RPC error on admin_reset_gameplay_tx
  store._simulatedRpcErrors = {
    admin_reset_gameplay_tx: new Error("simulated lock timeout on PostgreSQL engine"),
  };

  const req = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });

  // Must reject with 500 and controlled error message
  await assert.rejects(
    async () => await handle(req),
    (err) => err instanceof ApiError && err.status === 500 && err.message.includes("Reset gameplay failed")
  );

  // Critical regression verification: NO fallback writes or deletes occurred
  assert.strictEqual(store.submissions.length, 1, "Submissions must NOT be deleted if RPC fails");
  assert.strictEqual(store.round1_state[0].status, "ACTIVE", "round1_state must NOT be reset if RPC fails");
  assert.strictEqual(store.event_config[0].rounds["1"].state, "ACTIVE", "event_config must NOT be updated if RPC fails");
});

test("7. Overlapping Leaderboard Calculations: delayed pre-deadline calculation cannot be joined by post-deadline request", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const r1 = store.round1_state[0];
  const q1Id = store.questions[0].id;

  // Q1 is currently open
  r1.version = 10;
  r1.status = "ACTIVE";
  r1.phase = "QUESTION";
  r1.current_question_id = q1Id;
  r1.closed_question_ids = [];
  store.event_config[0].rounds["1"].state = "ACTIVE";

  // Team Alpha submits answer
  store.submissions.push({
    id: "sub-alpha-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: q1Id,
    round: 1,
    answer: "B",
    correct: true,
    score: 140,
    time_taken: 5.0,
  });

  // Pre-deadline calculation starts while Q1 is open
  const preDeadlinePromise = scores();

  // Now Q1 closes and advances to RESULT phase with a new version and closed_question_ids
  r1.version = 11;
  r1.phase = "RESULT";
  r1.closed_question_ids = [q1Id];

  // Standings requested after question close
  const postDeadlinePromise = scores();

  const [preResult, postResult] = await Promise.all([preDeadlinePromise, postDeadlinePromise]);

  // Pre-deadline calculation must mask Q1 score (unclosed)
  const preAlpha = preResult.find((r) => r.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(preAlpha.round1, 0, "Pre-deadline calculation must not leak open question score");

  // Post-deadline calculation must have its own fresh calculation including Q1's closed score
  const postAlpha = postResult.find((r) => r.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(postAlpha.round1, 140, "Post-deadline request must include Q1's closed score and not join pre-deadline calculation");
});

test("8. Complete Score Queries: 50 teams × 30 questions (1,500 submissions) with 1,000-row limit are fully calculated and exported without truncation", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Create 50 teams
  const teamIds = [];
  store.teams = [];
  for (let i = 1; i <= 50; i++) {
    const tid = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    teamIds.push(tid);
    store.teams.push({
      id: tid,
      team_name: `Trading Desk ${i}`,
      college: `Institute ${i}`,
    });
  }

  // Create 30 questions
  const questionIds = [];
  store.questions = [];
  for (let q = 1; q <= 30; q++) {
    const qid = `10000000-0000-0000-0000-${String(q).padStart(12, "0")}`;
    questionIds.push(qid);
    store.questions.push({
      id: qid,
      round: 1,
      text: `Question ${q}`,
      options: ["A", "B", "C", "D"],
      correct_answer: "A",
      base_points: 100,
      time_limit: 30,
      question_order: q,
    });
  }

  // Create 1,500 submissions (50 teams × 30 questions)
  store.submissions = [];
  let subCount = 0;
  for (const tid of teamIds) {
    for (const qid of questionIds) {
      subCount++;
      store.submissions.push({
        id: `sub-${subCount}`,
        team_id: tid,
        question_id: qid,
        round: 1,
        answer: "A",
        correct: true,
        score: 100,
        time_taken: 5.0,
        submitted_at: new Date().toISOString(),
      });
    }
  }
  assert.strictEqual(store.submissions.length, 1500, "Must have exactly 1,500 submissions");

  // Mark all 30 questions closed
  store.round1_state[0].status = "COMPLETED";
  store.round1_state[0].phase = "COMPLETED";
  store.round1_state[0].closed_question_ids = [...questionIds];
  store.event_config[0].rounds["1"].state = "COMPLETED";

  // Simulate PostgREST API limit of 1,000 rows per query
  store._simulatedRowLimit = 1000;

  // (a) computeScores must retrieve all 1,500 rows across pages and compute every team's full score
  const computed = await computeScores();
  assert.strictEqual(computed.length, 50, "All 50 teams must be returned in leaderboard");

  for (const teamScore of computed) {
    // 30 questions × 100 points = 3,000 points
    assert.strictEqual(
      teamScore.round1,
      3000,
      `Team ${teamScore.team_id} must have complete score of 3,000 points without row truncation`
    );
  }

  // (b) Export /api/admin/export/round1 must also export all 1,500 submissions without truncation
  const exportReq = new Request("http://localhost/api/admin/export/round1", {
    method: "GET",
    headers: { authorization: "Bearer user-admin" },
  });
  const exportRes = await handle(exportReq);
  assert.strictEqual(exportRes.status, 200);
  const csvText = await exportRes.text();
  const csvLines = csvText.trim().split("\n");
  // 1 header line + 1,500 data lines = 1,501 lines
  assert.strictEqual(csvLines.length, 1501, "Export must contain exactly 1 header + 1,500 submission rows");
});

test("9. Schema ordering audit: all() correctly paginates score_overrides using composite key without querying non-existent id column", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Populate score_overrides without any id column
  store.score_overrides = [
    { team_id: "00000000-0000-0000-0000-000000000010", round: 1, new_score: 150, reason: "Adjustment 1" },
    { team_id: "00000000-0000-0000-0000-000000000010", round: 2, new_score: 200, reason: "Adjustment 2" },
    { team_id: "00000000-0000-0000-0000-000000000020", round: 1, new_score: 175, reason: "Adjustment 3" },
  ];

  // (a) Calling all("score_overrides") must NOT query 'id' column and must succeed cleanly
  const overrides = await all("score_overrides");
  assert.strictEqual(overrides.length, 3, "Must fetch all 3 overrides using composite key");
  assert.strictEqual(overrides[0].team_id, "00000000-0000-0000-0000-000000000010");

  // (b) computeScores() utilizes all("score_overrides") internally: must succeed and apply overrides
  store.round1_state[0].status = "COMPLETED";
  store.round1_state[0].phase = "COMPLETED";
  const scoresResult = await computeScores();
  const team1 = scoresResult.find((t) => t.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(team1.round1, 150, "Override score of 150 must be applied to team 1 round 1");
});

test("10. Expired phase advancement at Q1 deadline + 1s: Pause freezes RESULT phase with ~9s remaining; Stop retains Q1 as closed and counts points", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const q1Id = store.questions[0].id;
  const nowMs = Date.now();
  const deadlineMs = nowMs - 1000; // Q1 deadline passed 1 second ago

  // Setup Round 1 in active QUESTION phase with expired deadline (deadline + 1s)
  store.event_config[0].rounds["1"].state = "ACTIVE";
  store.round1_state[0] = {
    ...store.round1_state[0],
    status: "ACTIVE",
    phase: "QUESTION",
    current_question_index: 0,
    current_question_id: q1Id,
    total_questions: 2,
    phase_start_at: new Date(deadlineMs - 30000).toISOString(),
    phase_ends_at: new Date(deadlineMs).toISOString(),
    is_paused: false,
    paused_remaining_ms: 0,
    countdown_seconds: 10,
    result_seconds: 10,
    closed_question_ids: [],
    version: 1,
  };

  // Add desk submission
  store.submissions.push({
    id: "sub-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: q1Id,
    round: 1,
    answer: "B",
    correct: true,
    score: 140,
    time_taken: 5.0,
  });

  // (a) Admin hits PAUSE at Q1 deadline + 1 second WITHOUT an intervening status request
  const pauseReq = new Request("http://localhost/api/rounds/1/state", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ state: "PAUSED" }),
  });
  const pauseRes = await handle(pauseReq);
  assert.strictEqual(pauseRes.status, 200);

  const pausedState = store.round1_state[0];
  assert.strictEqual(pausedState.status, "PAUSED");
  assert.strictEqual(pausedState.is_paused, true);
  // Crucial: Must freeze the RESULT phase, NOT the expired QUESTION phase!
  assert.strictEqual(pausedState.pause_phase, "RESULT", "Pause must advance to and freeze RESULT phase");
  assert.ok(
    pausedState.paused_remaining_ms >= 8000 && pausedState.paused_remaining_ms <= 10000,
    `paused_remaining_ms (${pausedState.paused_remaining_ms}) must reflect ~9s remaining in RESULT phase`
  );
  assert.ok(
    pausedState.closed_question_ids.includes(q1Id),
    "Q1 must be recorded in closed_question_ids upon phase advancement"
  );

  // (b) Test STOP EVENT at Q1 deadline + 1 second: retains Q1 as closed and counts points
  // Re-seed unpaused state with deadline expired 1 second ago
  store.round1_state[0] = {
    ...store.round1_state[0],
    status: "ACTIVE",
    phase: "QUESTION",
    current_question_index: 0,
    current_question_id: q1Id,
    total_questions: 1,
    phase_start_at: new Date(deadlineMs - 30000).toISOString(),
    phase_ends_at: new Date(deadlineMs).toISOString(),
    is_paused: false,
    paused_remaining_ms: 0,
    closed_question_ids: [],
    version: 5,
  };

  const stopReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "stop" }),
  });
  const stopRes = await handle(stopReq);
  assert.strictEqual(stopRes.status, 200);

  const stoppedState = store.round1_state[0];
  assert.strictEqual(stoppedState.status, "COMPLETED");
  assert.ok(
    stoppedState.closed_question_ids.includes(q1Id),
    "Stop event must retain Q1 as closed when deadline passed"
  );

  // Compute scores: team Alpha gets points for Q1 because its deadline genuinely passed!
  const rows = await computeScores();
  const alphaScore = rows.find((r) => r.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(alphaScore.round1, 140, "Earned points for passed question must be preserved");

  // (c) Contrast check: If Q1 deadline has NOT passed (e.g. 15s remaining), stop must NOT close Q1 prematurely
  store.round1_state[0] = {
    ...store.round1_state[0],
    status: "ACTIVE",
    phase: "QUESTION",
    current_question_index: 0,
    current_question_id: q1Id,
    phase_start_at: new Date().toISOString(),
    phase_ends_at: new Date(Date.now() + 15000).toISOString(),
    closed_question_ids: [],
    version: 8,
  };
  const stopEarlyReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "stop" }),
  });
  await handle(stopEarlyReq);
  assert.ok(
    !store.round1_state[0].closed_question_ids.includes(q1Id),
    "Stop event must NEVER close a question prematurely when deadline has not passed"
  );
});

test("11. Reset Gameplay Recovery: admin_reset_gameplay_tx wipes gameplay data, updates round1_state to WAITING with accurate total_questions, and recovers participant status", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Simulate played state: Round 1 COMPLETED with submissions and score overrides
  store.round1_state[0] = {
    ...store.round1_state[0],
    status: "COMPLETED",
    phase: "COMPLETED",
    current_question_index: 2,
    total_questions: 3,
    phase_start_at: null,
    phase_ends_at: null,
    version: 12,
  };
  store.event_config[0].rounds["1"].state = "COMPLETED";
  store.submissions = [
    { id: "sub-1", team_id: "00000000-0000-0000-0000-000000000010", question_id: "q-1", round: 1, score: 140 },
  ];

  // Participant calls /rounds/1/status before reset -> sees COMPLETED
  const preReq = new Request("http://localhost/api/rounds/1/status", {
    method: "GET",
    headers: { authorization: "Bearer user-alpha-1" },
  });
  const preRes = await handle(preReq);
  const preData = await preRes.json();
  assert.strictEqual(preData.phase, "COMPLETED");
  assert.strictEqual(preData.round_state, "COMPLETED");

  // Admin executes reset gameplay action
  const resetReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });
  const resetRes = await handle(resetReq);
  assert.strictEqual(resetRes.status, 200);

  // Assert submissions wiped
  assert.strictEqual(store.submissions.length, 0);

  // Assert event_config rounds reset to UPCOMING
  assert.strictEqual(store.event_config[0].rounds["1"].state, "UPCOMING");

  // Participant calls /rounds/1/status after reset -> automatically recovers to WAITING without requiring manual refresh
  const postReq = new Request("http://localhost/api/rounds/1/status", {
    method: "GET",
    headers: { authorization: "Bearer user-alpha-1" },
  });
  const postRes = await handle(postReq);
  const postData = await postRes.json();

  assert.strictEqual(postData.phase, "WAITING", "Participant status phase must recover to WAITING automatically");
  assert.strictEqual(postData.status, "IDLE", "Participant status must recover to IDLE");
  assert.strictEqual(postData.round_state, "UPCOMING", "Round state must be UPCOMING");
  assert.strictEqual(postData.total_questions, store.questions.filter((q) => q.round === 1).length, "Total questions must reflect configured question count");
});

test("12. Phone Number Validation: 10 ASCII digits enforced, leading zeros preserved, invalid requests rejected without creating auth user or team", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();

  // (a) Valid 10-digit phone with leading zero: "0123456789"
  const validReq = new Request("http://localhost/api/auth/register-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_name: "Delta Traders",
      leader_name: "Delta Leader",
      leader_email: "delta@test.com",
      leader_phone: "0123456789",
      college: "Delta University",
      password: "password123",
      members: [],
    }),
  });
  const validRes = await handle(validReq);
  assert.strictEqual(validRes.status, 200, "Valid 10-digit string with leading zero must be accepted");
  const validData = await validRes.json();
  assert.strictEqual(validData.ok, true);

  const deltaTeam = store.teams.find((t) => t.team_name === "Delta Traders");
  assert.ok(deltaTeam, "Team must be created");
  assert.strictEqual(deltaTeam.leader_phone, "0123456789", "Leading zero must be preserved in team record");

  // (b) 9 digits: rejected with 422, zero auth users created
  const createdBefore = (store._createdUsers || []).length;
  const teamsBefore = store.teams.length;

  const shortReq = new Request("http://localhost/api/auth/register-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_name: "Short Team",
      leader_name: "Short Leader",
      leader_email: "short@test.com",
      leader_phone: "012345678", // 9 digits
      college: "Short Univ",
      password: "password123",
    }),
  });
  await assert.rejects(
    async () => await handle(shortReq),
    (err) => err instanceof ApiError && err.status === 422 && err.message.includes("Leader phone must be exactly 10 digits")
  );

  // Verify NO user created and NO team inserted
  assert.strictEqual((store._createdUsers || []).length, createdBefore, "No auth user should be created on invalid phone");
  assert.strictEqual(store.teams.length, teamsBefore, "No team should be created on invalid phone");

  // (c) 11 digits: rejected with 422
  const longReq = new Request("http://localhost/api/auth/register-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_name: "Long Team",
      leader_name: "Long Leader",
      leader_email: "long@test.com",
      leader_phone: "01234567890", // 11 digits
      college: "Long Univ",
      password: "password123",
    }),
  });
  await assert.rejects(
    async () => await handle(longReq),
    (err) => err instanceof ApiError && err.status === 422 && err.message.includes("Leader phone must be exactly 10 digits")
  );

  // (d) Non-digits (letters or punctuation): rejected with 422
  const nonDigitReq = new Request("http://localhost/api/auth/register-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team_name: "Alpha Punct Team",
      leader_name: "Punct Leader",
      leader_email: "punct@test.com",
      leader_phone: "012-345-678", // punctuation
      college: "Punct Univ",
      password: "password123",
    }),
  });
  await assert.rejects(
    async () => await handle(nonDigitReq),
    (err) => err instanceof ApiError && err.status === 422 && err.message.includes("Leader phone must be exactly 10 digits")
  );
});

test("13. Zero Unearned R3 Score: unplayed and pending-only trades earn 0 R3 score and 0 total, verified trades earn points, and overrides are preserved", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010"; // Team Alpha
  const bravoId = "00000000-0000-0000-0000-000000000020"; // Team Bravo

  // (a) Unplayed teams: zero submissions, zero trades
  store.submissions = [];
  store.trades = [];
  store.score_overrides = [];

  const unplayedScores = await computeScores();
  const unplayedAlpha = unplayedScores.find((r) => r.team_id === alphaId);
  const unplayedBravo = unplayedScores.find((r) => r.team_id === bravoId);

  assert.strictEqual(unplayedAlpha.round3, 0, "Unplayed team must have R3 = 0");
  assert.strictEqual(unplayedAlpha.total, 0, "Unplayed team must have total = 0");
  assert.strictEqual(unplayedBravo.round3, 0, "Unplayed team Bravo must have R3 = 0");
  assert.strictEqual(unplayedBravo.total, 0, "Unplayed team Bravo must have total = 0");
  assert.strictEqual(unplayedAlpha.risk_score, 500, "Baseline risk score metric remains 500");

  // (b) Pending-only and rejected-only trades must contribute 0
  store.trades = [
    {
      id: "trade-1",
      team_id: alphaId,
      trade_number: 1,
      asset: "AAPL",
      risk_per_trade: 2,
      pl_percentage: 10,
      verification_status: "PENDING",
    },
    {
      id: "trade-2",
      team_id: bravoId,
      trade_number: 1,
      asset: "TSLA",
      risk_per_trade: 2,
      pl_percentage: 15,
      verification_status: "REJECTED",
    },
  ];

  invalidateLeaderboardCache();
  const pendingScores = await computeScores();
  const pendingAlpha = pendingScores.find((r) => r.team_id === alphaId);
  const rejectedBravo = pendingScores.find((r) => r.team_id === bravoId);

  assert.strictEqual(pendingAlpha.round3, 0, "Pending-only trades must contribute 0 to R3");
  assert.strictEqual(pendingAlpha.total, 0, "Pending-only trades must contribute 0 to total");
  assert.strictEqual(rejectedBravo.round3, 0, "Rejected-only trades must contribute 0 to R3");
  assert.strictEqual(rejectedBravo.total, 0, "Rejected-only trades must contribute 0 to total");

  // (c) Verified trade earns points according to formula
  store.trades.push({
    id: "trade-3",
    team_id: alphaId,
    trade_number: 2,
    asset: "NVDA",
    risk_per_trade: 1,
    pl_percentage: 5,
    verification_status: "VERIFIED",
  });

  invalidateLeaderboardCache();
  const verifiedScores = await computeScores();
  const verifiedAlpha = verifiedScores.find((r) => r.team_id === alphaId);
  assert.ok(verifiedAlpha.round3 > 0, "Verified trade must earn R3 points");
  assert.ok(verifiedAlpha.total > 0, "Verified trade must contribute to total");

  // (d) Explicit admin override, including 0, is preserved
  store.score_overrides = [
    { team_id: alphaId, round: 3, new_score: 0 },
    { team_id: bravoId, round: 3, new_score: 850 },
  ];

  invalidateLeaderboardCache();
  const overrideScores = await computeScores();
  const overrideAlpha = overrideScores.find((r) => r.team_id === alphaId);
  const overrideBravo = overrideScores.find((r) => r.team_id === bravoId);

  assert.strictEqual(overrideAlpha.round3, 0, "Explicit override of 0 must be preserved");
  assert.strictEqual(overrideBravo.round3, 850, "Explicit override of 850 must be preserved");

  // (e) /scores/me and /leaderboard agree
  const meReq = new Request("http://localhost/api/scores/me", {
    method: "GET",
    headers: { authorization: "Bearer user-alpha-1" },
  });
  const meRes = await handle(meReq);
  const meData = await meRes.json();
  assert.strictEqual(meData.round3, overrideAlpha.round3);
  assert.strictEqual(meData.total, overrideAlpha.total);

  const lbReq = new Request("http://localhost/api/leaderboard", { method: "GET" });
  const lbRes = await handle(lbReq);
  const lbData = await lbRes.json();
  const lbAlpha = lbData.rows.find((r) => r.team_id === alphaId);
  assert.strictEqual(lbAlpha.round3, overrideAlpha.round3);
  assert.strictEqual(lbAlpha.total, overrideAlpha.total);
});

test("14. Authoritative Results Finalization: R3 completion and Stop Event do not finalize, pending verification blocks, explicit finalization succeeds, and reset clears", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // (a) R1 completed while R3 is upcoming -> event is NOT finalized
  store.event_config[0].rounds["1"].state = "COMPLETED";
  store.event_config[0].rounds["2"].state = "UPCOMING";
  store.event_config[0].rounds["3"].state = "UPCOMING";
  store.event_config[0].results_finalized = false;

  const cfgRes1 = await handle(new Request("http://localhost/api/event/config", { method: "GET" }));
  const cfgData1 = await cfgRes1.json();
  assert.strictEqual(Boolean(cfgData1?.results_finalized), false, "Completing R1 alone must NOT finalize results");

  // (b) R3 completed but results unfinalized -> results_finalized remains false (Current Standings)
  store.event_config[0].rounds["3"].state = "COMPLETED";
  invalidateConfigCache();
  const cfgRes2 = await handle(new Request("http://localhost/api/event/config", { method: "GET" }));
  const cfgData2 = await cfgRes2.json();
  assert.strictEqual(Boolean(cfgData2?.results_finalized), false, "R3 completed alone must NOT finalize results without explicit admin action");

  // (c) Stop Event while verification is pending -> Stop Event succeeds but explicit finalization is blocked
  const stopRes = await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "stop" }),
  }));
  assert.strictEqual(stopRes.status, 200);

  // Add pending trade
  store.trades.push({
    id: "trade-pending-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    trade_number: 1,
    asset: "NVDA",
    account_size: 100000,
    risk_per_trade: 2,
    result_type: "PROFIT",
    profit: 2000,
    loss: 0,
    pl_percentage: 2,
    verification_status: "PENDING",
  });

  // Attempt explicit finalization while pending verification exists -> must be blocked
  const finalizeBlockedReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize" }),
  });
  await assert.rejects(
    async () => await handle(finalizeBlockedReq),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Cannot finalize results") && err.message.includes("pending review")
  );

  // (d) Explicit finalization succeeds after pending trade is reviewed
  const verifyRes = await handle(new Request("http://localhost/api/admin/trades/trade-pending-1/verify", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ status: "VERIFIED" }),
  }));
  assert.strictEqual(verifyRes.status, 200);

  const finalizeReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize" }),
  });
  const finalizeRes = await handle(finalizeReq);
  assert.strictEqual(finalizeRes.status, 200);
  const finalizeData = await finalizeRes.json();
  assert.strictEqual(finalizeData.results_finalized, true, "Explicit finalization action must persist results_finalized = true");

  // (e) Post-Finalization: reject all score-changing actions
  // 1. Round 1 submit
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/rounds/1/submit", {
      method: "POST",
      headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
      body: JSON.stringify({ question_id: store.questions[0].id, answer: "A" }),
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 2. Round 2 submit
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/rounds/2/submit", {
      method: "POST",
      headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
      body: JSON.stringify({ question_id: store.questions[0].id, answer: "A", time_taken: 5 }),
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 3. Round 3 trades
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/rounds/3/trades", {
      method: "POST",
      headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
      body: JSON.stringify({ asset: "AAPL", account_size: 100000, risk_per_trade: 1, result_type: "PROFIT", profit: 500, loss: 0, pl_percentage: 1 }),
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 4. Admin trade verification
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/admin/trades/trade-pending-1/verify", {
      method: "POST",
      headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
      body: JSON.stringify({ status: "REJECTED", reason: "Post-finalization test" }),
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 5. Admin score override
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/admin/score-override", {
      method: "POST",
      headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
      body: JSON.stringify({ team_id: "00000000-0000-0000-0000-000000000010", round: 1, new_score: 999, reason: "Test" }),
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 6. Admin delete team
  await assert.rejects(
    async () => await handle(new Request("http://localhost/api/admin/teams/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      headers: { authorization: "Bearer user-admin" },
    })),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // (f) Explicit Admin Reopen Action: clears results_finalized
  const reopenRes = await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "reopen" }),
  }));
  assert.strictEqual(reopenRes.status, 200);
  const reopenData = await reopenRes.json();
  assert.strictEqual(reopenData.results_finalized, false, "Admin reopen action must set results_finalized = false");

  // Score override now succeeds after reopening!
  const overrideAfterReopen = await handle(new Request("http://localhost/api/admin/score-override", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ team_id: "00000000-0000-0000-0000-000000000010", round: 1, new_score: 999, reason: "Adjustment after reopen" }),
  }));
  assert.strictEqual(overrideAfterReopen.status, 200);

  // Finalize again to test Reset Gameplay clearing behavior
  await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize" }),
  }));

  // (g) Reset Gameplay clears finalization back to Current Standings
  const resetRes = await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  }));
  assert.strictEqual(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.strictEqual(resetData.results_finalized, false, "Reset Gameplay must clear results_finalized to false");
});

test("15. Score Consistency & Cache Invalidation: trade verification/rejection, overrides, and reset immediately invalidate cache; scores/me, leaderboard, and export agree", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010";

  // Initially unplayed: baseline R3 = 0, total = 0
  const initScores = await computeScores();
  const initAlpha = initScores.find((r) => r.team_id === alphaId);
  assert.strictEqual(initAlpha.round3, 0);
  assert.strictEqual(initAlpha.total, 0);

  // Warm cache via /api/leaderboard
  const warmRes = await handle(new Request("http://localhost/api/leaderboard", { method: "GET" }));
  const warmData = await warmRes.json();
  const warmAlpha = warmData.rows.find((r) => r.team_id === alphaId);
  assert.strictEqual(warmAlpha.round3, 0);

  // Add pending trade (must contribute 0 points)
  store.trades.push({
    id: "trade-cache-1",
    team_id: alphaId,
    trade_number: 1,
    asset: "TSLA",
    account_size: 100000,
    risk_per_trade: 2,
    result_type: "PROFIT",
    profit: 5000,
    loss: 0,
    pl_percentage: 5,
    verification_status: "PENDING",
  });

  // Verify trade: should invalidate leaderboard cache automatically
  const verifyRes = await handle(new Request("http://localhost/api/admin/trades/trade-cache-1/verify", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ status: "VERIFIED" }),
  }));
  assert.strictEqual(verifyRes.status, 200);

  // Next requests to /scores/me, /leaderboard, and /export must all see updated verified score without stale cache
  const meRes = await handle(new Request("http://localhost/api/scores/me", {
    headers: { authorization: "Bearer user-alpha-1" },
  }));
  const meData = await meRes.json();
  assert.ok(meData.round3 > 0, "Trade verification must invalidate cache and award R3 score to scores/me");

  const lbRes = await handle(new Request("http://localhost/api/leaderboard", { method: "GET" }));
  const lbData = await lbRes.json();
  const lbAlpha = lbData.rows.find((r) => r.team_id === alphaId);
  assert.strictEqual(lbAlpha.round3, meData.round3, "Leaderboard and scores/me must agree");
  assert.strictEqual(lbAlpha.total, meData.total, "Leaderboard and scores/me totals must agree");

  const exportRes = await handle(new Request("http://localhost/api/admin/export/leaderboard", {
    headers: { authorization: "Bearer user-admin" },
  }));
  const exportCsv = await exportRes.text();
  assert.ok(exportCsv.includes(String(lbAlpha.round3)), "Admin CSV export must agree with leaderboard score");

  // Score override: overrides R3 score and invalidates cache
  const overrideRes = await handle(new Request("http://localhost/api/admin/score-override", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ team_id: alphaId, round: 3, new_score: 950, reason: "Adjustment" }),
  }));
  assert.strictEqual(overrideRes.status, 200);

  const meOverrideRes = await handle(new Request("http://localhost/api/scores/me", {
    headers: { authorization: "Bearer user-alpha-1" },
  }));
  const meOverride = await meOverrideRes.json();
  assert.strictEqual(meOverride.round3, 950, "Score override must immediately reflect in scores/me");

  const lbOverrideRes = await handle(new Request("http://localhost/api/leaderboard", { method: "GET" }));
  const lbOverride = await lbOverrideRes.json();
  const lbOverrideAlpha = lbOverride.rows.find((r) => r.team_id === alphaId);
  assert.strictEqual(lbOverrideAlpha.round3, 950, "Score override must immediately reflect in leaderboard");
  assert.strictEqual(lbOverrideAlpha.round3, meOverride.round3, "Leaderboard and scores/me must agree on override");

  // Reset Gameplay: resets scores to 0 and clears cache
  const resetRes = await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  }));
  assert.strictEqual(resetRes.status, 200);

  const meAfterReset = await (await handle(new Request("http://localhost/api/scores/me", {
    headers: { authorization: "Bearer user-alpha-1" },
  }))).json();
  assert.strictEqual(meAfterReset.round3, 0, "Reset must restore scores/me R3 to 0");
  assert.strictEqual(meAfterReset.total, 0, "Reset must restore scores/me total to 0");
});

test("16. Leaderboard Cache Invalidation Race: older in-flight calculation cannot repopulate stale data or remove newer in-flight entry", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010";

  // Simulate a deliberately delayed calculation for Request 1
  const originalFrom = client.from.bind(client);
  let firstOverridesQuery = true;

  client.from = (table) => {
    const builder = originalFrom(table);
    if (table === "score_overrides" && firstOverridesQuery) {
      firstOverridesQuery = false;
      const snapshot = structuredClone(store.score_overrides);
      builder.then = (onFulfilled) => {
        // Delay Request 1 by 80ms to create overlapping calculation
        return new Promise((resolve) => setTimeout(resolve, 80))
          .then(() => onFulfilled({ data: snapshot, error: null }));
      };
    }
    return builder;
  };

  // 1. Request 1 starts calculating with initial state (score = 0)
  const req1Promise = scores();

  // Give Request 1 time to register in inFlightLeaderboard Map
  await new Promise((r) => setTimeout(r, 10));

  // 2. While Request 1 is still in flight, a score-changing operation occurs!
  store.score_overrides.push({
    team_id: alphaId,
    round: 1,
    new_score: 850,
    reason: "Mid-flight override",
    updated_at: new Date().toISOString(),
  });
  // Invalidation clears cache and increments cacheGeneration
  invalidateLeaderboardCache();

  // 3. Request 2 starts after invalidation; computes updated score (850)
  const req2Promise = scores();
  const req2Result = await req2Promise;
  const alphaReq2 = req2Result.find((r) => r.team_id === alphaId);
  assert.strictEqual(alphaReq2.round1, 850, "Request 2 must calculate updated score 850");

  // 4. Now await Request 1 (the delayed obsolete calculation)
  const req1Result = await req1Promise;
  const alphaReq1 = req1Result.find((r) => r.team_id === alphaId);
  assert.strictEqual(alphaReq1.round1, 0, "Request 1 computes obsolete score 0 based on old state");

  // 5. REGRESSION CHECK: Request 1 must NOT have repopulated the cache with stale score 0!
  // Subsequent scores() call must return 850 from cache, NOT obsolete 0
  const req3Result = await scores();
  const alphaReq3 = req3Result.find((r) => r.team_id === alphaId);
  assert.strictEqual(alphaReq3.round1, 850, "Cache must NOT be polluted by delayed obsolete calculation! Expected 850.");
});

test("17. Concurrency: finalization coordinates with concurrent submissions so no answers slip through during publication", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010";
  const qId = store.questions[0].id;

  // Mark all rounds completed so finalization can proceed
  store.event_config[0].rounds["1"].state = "COMPLETED";
  store.event_config[0].rounds["2"].state = "COMPLETED";
  store.event_config[0].rounds["3"].state = "COMPLETED";
  const r1 = store.round1_state.find((r) => r.id === "current");
  r1.status = "COMPLETED";
  r1.phase = "COMPLETED";

  // Simulate concurrent finalization and submission attempts
  const finalizePromise = handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize" }),
  }));

  const subPromise = handle(new Request("http://localhost/api/rounds/1/submit", {
    method: "POST",
    headers: { authorization: "Bearer user-alpha-1", "content-type": "application/json" },
    body: JSON.stringify({ question_id: qId, answer: "A" }),
  }));

  const [finalizeRes, subRes] = await Promise.allSettled([finalizePromise, subPromise]);

  assert.strictEqual(finalizeRes.status, "fulfilled");
  assert.strictEqual(finalizeRes.value.status, 200);

  // Submissions concurrent with or after finalization must be rejected (400)
  if (subRes.status === "fulfilled") {
    assert.strictEqual(subRes.value.status, 400, "Submission concurrent with finalization must be rejected");
  } else {
    assert.ok(subRes.reason instanceof ApiError && subRes.reason.status === 400);
  }

  // Verify zero submissions recorded post-finalization
  assert.strictEqual(store.submissions.length, 0, "No submission may slip through during publication");
});

test("18. Regression: Delayed score-override starting while unfinalized cannot write after results are finalized", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010";

  // Initially unfinalized with all rounds completed and 0 pending trades
  store.event_config[0].results_finalized = false;
  store.event_config[0].rounds["1"].state = "COMPLETED";
  store.event_config[0].rounds["2"].state = "COMPLETED";
  store.event_config[0].rounds["3"].state = "COMPLETED";
  const r1 = store.round1_state.find((r) => r.id === "current");
  r1.status = "COMPLETED";
  r1.phase = "COMPLETED";

  // 1. Start /api/admin/score-override while results_finalized is false
  let releaseBody;
  const delayedBodyPromise = new Promise((resolve) => {
    releaseBody = resolve;
  });

  const delayedRequest = {
    method: "POST",
    url: "http://localhost/api/admin/score-override",
    headers: new Headers({ authorization: "Bearer user-admin", "content-type": "application/json" }),
    json: async () => {
      // Delay before returning the parsed body
      await delayedBodyPromise;
      return { team_id: alphaId, round: 1, new_score: 999, reason: "Delayed override test" };
    },
  };

  // Launch the override request in the background
  const overridePromise = handle(delayedRequest);

  // Give the request a moment to enter handle() while results_finalized is still false
  await new Promise((r) => setTimeout(r, 20));

  // 2. Finalize results successfully while the override body is delayed
  const finalizeRes = await handle(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { authorization: "Bearer user-admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize" }),
  }));
  assert.strictEqual(finalizeRes.status, 200);
  assert.strictEqual(store.event_config[0].results_finalized, true, "Finalization must succeed");

  // 3. Release the override body
  releaseBody();

  // 4. The override MUST be rejected at the write boundary (HTTP 400), not write score 999!
  await assert.rejects(
    async () => await overridePromise,
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes("Results are finalized")
  );

  // 5. Verify the override was NOT written to the database!
  const savedOverride = store.score_overrides.find((o) => o.team_id === alphaId && o.round === 1);
  assert.strictEqual(savedOverride, undefined, "Score override must NOT be saved after finalization");

  // 6. Verify scores/me or leaderboard do not reflect the override
  const allSc = await computeScores();
  const alphaScore = allSc.find((r) => r.team_id === alphaId);
  assert.notStrictEqual(alphaScore.round1, 999, "Alpha round 1 score must NOT be 999");
});

test("19. Database write boundary: All score-changing RPCs reject when results are finalized", async () => {
  const { client, store } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  const alphaId = "00000000-0000-0000-0000-000000000010";

  // Mark results as finalized
  store.event_config[0].results_finalized = true;

  // 1. Score override
  const overrideRes = await client.rpc("admin_set_score_override_tx", {
    p_team_id: alphaId,
    p_round: 1,
    p_new_score: 500,
    p_reason: "Test",
  });
  assert.strictEqual(overrideRes.data.ok, false);
  assert.strictEqual(overrideRes.data.code, "FINALIZED");

  // 2. Trade verification
  const verifyRes = await client.rpc("admin_verify_trade_tx", {
    p_trade_id: "trade-1",
    p_status: "VERIFIED",
  });
  assert.strictEqual(verifyRes.data.ok, false);
  assert.strictEqual(verifyRes.data.code, "FINALIZED");

  // 3. Trade deletion
  const deleteTradeRes = await client.rpc("admin_delete_trade_tx", {
    p_trade_id: "trade-1",
  });
  assert.strictEqual(deleteTradeRes.data.ok, false);
  assert.strictEqual(deleteTradeRes.data.code, "FINALIZED");

  // 4. Team deletion
  const deleteTeamRes = await client.rpc("admin_delete_team_tx", {
    p_team_id: alphaId,
  });
  assert.strictEqual(deleteTeamRes.data.ok, false);
  assert.strictEqual(deleteTeamRes.data.code, "FINALIZED");

  // 5. Round 2 submission
  const r2Res = await client.rpc("submit_round2_answer_tx", {
    p_team_id: alphaId,
    p_question_id: "q-1",
    p_answer: "A",
    p_time_taken: 5,
  });
  assert.strictEqual(r2Res.data.ok, false);
  assert.strictEqual(r2Res.data.code, "FINALIZED");

  // 6. Round 3 trade submission
  const r3Res = await client.rpc("submit_round3_trade_tx", {
    p_team_id: alphaId,
    p_asset: "AAPL",
    p_account_size: 100000,
    p_risk_per_trade: 1,
    p_result_type: "PROFIT",
    p_profit: 100,
    p_loss: 0,
    p_pl_percentage: 1,
  });
  assert.strictEqual(r3Res.data.ok, false);
  assert.strictEqual(r3Res.data.code, "FINALIZED");
});

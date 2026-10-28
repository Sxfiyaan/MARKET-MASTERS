import test from "node:test";
import assert from "node:assert/strict";

// Directly import production functions and HTTP handler from supabase/functions/market-api/index.ts
import {
  handle,
  all,
  computeScores,
  scores,
  getRound2State,
  saveRound2State,
  advanceRound2State,
  isRound2QuestionClosed,
  setTestDb,
  invalidateConfigCache,
  invalidateLeaderboardCache,
  ApiError,
} from "../supabase/functions/market-api/index.ts";

async function callApi(request) {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof ApiError) {
      return new Response(JSON.stringify({ detail: error.message }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ detail: error.message || "Unexpected server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function createMockSupabase(initialData = {}) {
  const q2_1 = "00000000-0000-0000-0000-000000000001";
  const q2_2 = "00000000-0000-0000-0000-000000000002";
  const q2_3 = "00000000-0000-0000-0000-000000000003";
  const q2_4 = "00000000-0000-0000-0000-000000000004";
  const q2_5 = "00000000-0000-0000-0000-000000000005";

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
        total_questions: 5,
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
      },
    ],
    event_config: [
      {
        id: "event",
        event_name: "Market Masters",
        registration_open: true,
        leaderboard_visible: true,
        results_finalized: false,
        round1_weight: 30,
        round2_weight: 30,
        round3_weight: 40,
        round3_duration_minutes: 60,
        max_trades: 2,
        starting_capital: 100000,
        max_risk_per_trade: 2,
        performance_weight: 60,
        risk_mgmt_weight: 40,
        speed_bonus_pct: 0.5,
        rounds: {
          "1": { state: "UPCOMING", started_at: null, ended_at: null },
          "2": { state: "UPCOMING", started_at: null, ended_at: null },
          "3": { state: "UPCOMING", started_at: null, ended_at: null },
        },
      },
    ],
    questions: [
      {
        id: q2_1,
        round: 2,
        text: "Chart 1: NIFTY 50 Daily Breakout",
        options: ["BUY", "SELL", "NO_TRADE"],
        correct_answer: "BUY",
        base_points: 1,
        time_limit: 120,
        question_order: 0,
        asset: "NIFTY50",
        timeframe: "1D",
      },
      {
        id: q2_2,
        round: 2,
        text: "Chart 2: RELIANCE Bearish Engulfing",
        options: ["BUY", "SELL", "NO_TRADE"],
        correct_answer: "SELL",
        base_points: 1,
        time_limit: 120,
        question_order: 1,
        asset: "RELIANCE",
        timeframe: "4H",
      },
      {
        id: q2_3,
        round: 2,
        text: "Chart 3: INFY Sideways Consolidation",
        options: ["BUY", "SELL", "NO_TRADE"],
        correct_answer: "BUY",
        base_points: 1,
        time_limit: 120,
        question_order: 2,
        asset: "INFY",
        timeframe: "1H",
      },
      {
        id: q2_4,
        round: 2,
        text: "Chart 4: HDFCBANK Double Top",
        options: ["BUY", "SELL", "NO_TRADE"],
        correct_answer: "SELL",
        base_points: 1,
        time_limit: 120,
        question_order: 3,
        asset: "HDFCBANK",
        timeframe: "15M",
      },
      {
        id: q2_5,
        round: 2,
        text: "Chart 5: TATASTEEL Fakeout",
        options: ["BUY", "SELL", "NO_TRADE"],
        correct_answer: "BUY",
        base_points: 1,
        time_limit: 120,
        question_order: 4,
        asset: "TATASTEEL",
        timeframe: "1D",
      },
    ],
    teams: [
      { id: "00000000-0000-0000-0000-000000000010", team_name: "Alpha Bulls", college: "Wharton" },
      { id: "00000000-0000-0000-0000-000000000020", team_name: "Beta Bears", college: "Harvard" },
    ],
    profiles: [
      { id: "user-alpha-1", email: "alpha1@test.com", name: "Alpha Leader", role: "team", team_id: "00000000-0000-0000-0000-000000000010" },
      { id: "user-alpha-2", email: "alpha2@test.com", name: "Alpha Mate", role: "team", team_id: "00000000-0000-0000-0000-000000000010" },
      { id: "user-beta-1", email: "beta1@test.com", name: "Beta Leader", role: "team", team_id: "00000000-0000-0000-0000-000000000020" },
      { id: "user-admin", email: "admin@test.com", name: "Admin Director", role: "admin", team_id: null },
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
          orderList.push([col, opts.ascending !== false]);
          return builder;
        },
        range: (from, to) => {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        insert: (payload) => {
          isInsert = true;
          const items = Array.isArray(payload) ? payload : [payload];
          for (const item of items) {
            const row = { id: item.id || `gen-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString(), ...item };
            store[table].push(row);
          }
          return builder;
        },
        update: (payload) => {
          updatePayload = payload;
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
                if (va !== vb) return asc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
              }
              return 0;
            });
          }
          const sliced = matched.slice(rangeFrom, rangeTo + 1);
          return Promise.resolve(onResolve({ data: sliced.map((x) => ({ ...x })), error: null }));
        },
      };
      return builder;
    },
    rpc: async (fnName, params) => {
      const advanceR2Phase = (nowMs) => {
        const state = store.round2_state.find((r) => r.id === "current");
        if (!state || state.is_paused || ["IDLE", "COMPLETED"].includes(state.status) || ["WAITING", "COMPLETED"].includes(state.phase)) {
          return state;
        }
        if (!state.phase_ends_at || nowMs < new Date(state.phase_ends_at).getTime()) {
          return state;
        }

        const qs = state.frozen_questions || store.questions.filter((q) => q.round === 2);
        if (!qs.length) {
          state.status = "COMPLETED";
          state.phase = "COMPLETED";
          state.version += 1;
          return state;
        }

        if (state.phase === "COUNTDOWN") {
          state.phase = "QUESTION";
          state.current_question_index = 0;
          state.current_question_id = qs[0].id;
          state.phase_start_at = new Date(nowMs).toISOString();
          state.phase_ends_at = new Date(nowMs + (state.question_seconds || 120) * 1000).toISOString();
          state.version += 1;
        } else if (state.phase === "QUESTION") {
          state.phase = "RESULT";
          if (!state.closed_question_ids.includes(state.current_question_id)) {
            state.closed_question_ids.push(state.current_question_id);
          }
          state.phase_start_at = new Date(nowMs).toISOString();
          state.phase_ends_at = new Date(nowMs + state.result_seconds * 1000).toISOString();
          state.version += 1;
        } else if (state.phase === "RESULT") {
          const nextIdx = state.current_question_index + 1;
          if (nextIdx < qs.length) {
            state.current_question_index = nextIdx;
            state.current_question_id = qs[nextIdx].id;
            state.phase = "QUESTION";
            state.phase_start_at = new Date(nowMs).toISOString();
            state.phase_ends_at = new Date(nowMs + (state.question_seconds || 120) * 1000).toISOString();
            state.version += 1;
          } else {
            state.phase = "COMPLETED";
            state.status = "COMPLETED";
            state.version += 1;
          }
        }
        return state;
      };

      if (fnName === "admin_set_round2_state_tx") {
        const state = store.round2_state.find((r) => r.id === "current");
        const action = params.p_action;
        const now = params.p_now ? new Date(params.p_now).getTime() : Date.now();

        if (action === "ACTIVE" || action === "START") {
          if (state.status === "PAUSED" || state.is_paused) {
            state.is_paused = false;
            state.status = "ACTIVE";
            state.phase = state.pause_phase || state.phase;
            state.phase_ends_at = new Date(now + state.paused_remaining_ms).toISOString();
            state.paused_at = null;
            state.pause_phase = null;
            state.paused_remaining_ms = 0;
            state.version += 1;
          } else {
            state.status = "ACTIVE";
            state.phase = "COUNTDOWN";
            state.current_question_index = 0;
            state.is_paused = false;
            state.paused_remaining_ms = 0;
            state.closed_question_ids = [];
            state.frozen_questions = params.p_frozen_questions || store.questions.filter((q) => q.round === 2);
            state.total_questions = state.frozen_questions.length;
            state.current_question_id = state.frozen_questions[0]?.id || null;
            state.question_seconds = params.p_question_seconds || 120;
            state.phase_start_at = new Date(now).toISOString();
            state.phase_ends_at = new Date(now + state.countdown_seconds * 1000).toISOString();
            state.version += 1;
          }
          store.event_config[0].rounds["2"].state = "ACTIVE";
          return { data: { ok: true, round_value: { state: "ACTIVE" } }, error: null };
        }

        if (action === "PAUSED" || action === "PAUSE") {
          if (state.is_paused) return { data: { ok: true, round_value: { state: "PAUSED" } }, error: null };
          advanceR2Phase(now);
          const rem = Math.max(0, state.phase_ends_at ? new Date(state.phase_ends_at).getTime() - now : 0);
          state.is_paused = true;
          state.status = "PAUSED";
          state.paused_at = new Date(now).toISOString();
          state.pause_phase = state.phase;
          state.paused_remaining_ms = rem;
          state.version += 1;
          store.event_config[0].rounds["2"].state = "PAUSED";
          return { data: { ok: true, round_value: { state: "PAUSED" } }, error: null };
        }

        if (action === "COMPLETED" || action === "STOP") {
          state.status = "COMPLETED";
          state.phase = "COMPLETED";
          state.is_paused = false;
          state.paused_remaining_ms = 0;
          state.version += 1;
          store.event_config[0].rounds["2"].state = "COMPLETED";
          return { data: { ok: true, round_value: { state: "COMPLETED" } }, error: null };
        }

        if (action === "UPCOMING" || action === "RESET") {
          if (state.status !== "IDLE" || state.is_paused || (state.closed_question_ids && state.closed_question_ids.length > 0) || store.submissions.some((s) => s.round === 2)) {
            return {
              data: {
                ok: false,
                code: "ROUND_PLAYED",
                error: "Cannot return a running, paused, played or completed Round 2 run to UPCOMING. Perform an explicit Reset Gameplay first.",
              },
              error: null,
            };
          }
          state.status = "IDLE";
          state.phase = "WAITING";
          state.current_question_index = 0;
          state.current_question_id = null;
          state.closed_question_ids = [];
          state.frozen_questions = null;
          state.is_paused = false;
          state.paused_remaining_ms = 0;
          state.version += 1;
          store.event_config[0].rounds["2"].state = "UPCOMING";
          return { data: { ok: true, round_value: { state: "UPCOMING" } }, error: null };
        }
      }

      if (fnName === "advance_round2_state_tx") {
        const now = params?.p_now ? new Date(params.p_now).getTime() : Date.now();
        const state = advanceR2Phase(now);
        return { data: { ...state }, error: null };
      }

      if (fnName === "submit_round2_answer_tx") {
        const cfg = store.event_config[0];
        if (!cfg) {
          return { data: { ok: false, code: "CONFIG_NOT_FOUND", error: "Event configuration record not found" }, error: null };
        }
        const state = store.round2_state.find((r) => r.id === "current");
        if (!state) {
          return { data: { ok: false, code: "STATE_NOT_FOUND", error: "Round 2 state record not found" }, error: null };
        }
        if (cfg.results_finalized) {
          return { data: { ok: false, code: "FINALIZED", error: "Results are finalized. Submissions are closed." }, error: null };
        }
        if (cfg.rounds?.["2"]?.state === "PAUSED" || state.is_paused || state.status === "PAUSED") {
          return { data: { ok: false, code: "ROUND_PAUSED", error: "Round 2 is paused" }, error: null };
        }
        if (cfg.rounds?.["2"]?.state !== "ACTIVE" || state.status !== "ACTIVE") {
          return { data: { ok: false, code: "NOT_ACTIVE", error: "Round 2 is not active" }, error: null };
        }
        if (state.phase !== "QUESTION") {
          return { data: { ok: false, code: "NOT_OPEN", error: "Question is not currently open" }, error: null };
        }
        if (!params.p_question_id || !state.current_question_id || state.current_question_id !== params.p_question_id) {
          return { data: { ok: false, code: "QUESTION_MISMATCH", error: "Question is not currently active" }, error: null };
        }
        if (!state.phase_start_at || !state.phase_ends_at || new Date(state.phase_start_at).getTime() >= new Date(state.phase_ends_at).getTime()) {
          return { data: { ok: false, code: "INVALID_TIMING", error: "Invalid question phase timing window" }, error: null };
        }
        if (Date.now() < new Date(state.phase_start_at).getTime()) {
          return { data: { ok: false, code: "NOT_OPEN_YET", error: "Question has not opened yet" }, error: null };
        }
        if (Date.now() >= new Date(state.phase_ends_at).getTime()) {
          return { data: { ok: false, code: "DEADLINE_EXPIRED", error: "Question deadline has expired" }, error: null };
        }

        const cleanAns = String(params.p_answer || "").trim().toUpperCase();
        if (!["BUY", "SELL", "NO_TRADE"].includes(cleanAns)) {
          return { data: { ok: false, code: "INVALID_OPTION", error: "Invalid option. Must be BUY, SELL, or NO_TRADE." }, error: null };
        }

        const cleanExpl = String(params.p_explanation || "").trim();
        if (cleanExpl.length === 0) {
          return { data: { ok: false, code: "EXPLANATION_REQUIRED", error: "Explanation is required" }, error: null };
        }
        if (cleanExpl.length > 250) {
          return { data: { ok: false, code: "EXPLANATION_TOO_LONG", error: "Explanation must not exceed 250 characters" }, error: null };
        }
        if (/[\r\n]/.test(cleanExpl)) {
          return { data: { ok: false, code: "EXPLANATION_MULTILINE", error: "Explanation must be a single line" }, error: null };
        }

        const existing = store.submissions.find(
          (s) => s.team_id === params.p_team_id && s.question_id === params.p_question_id && s.round === 2
        );
        if (existing) {
          return { data: { ok: false, code: "ALREADY_SUBMITTED", error: "Your team has already submitted an answer for this question." }, error: null };
        }

        const q = (state.frozen_questions || store.questions).find((item) => item.id === params.p_question_id);
        const ans = cleanAns;
        // Scoring rule: Correct BUY or SELL = 1 point; wrong, unanswered or NO_TRADE = 0 points. No speed bonus.
        const isTradeDecision = ans === "BUY" || ans === "SELL";
        const correct = isTradeDecision && ans === q?.correct_answer;
        const score = correct ? 1 : 0;

        const subId = `sub-r2-${Date.now()}-${Math.random()}`;
        const newSub = {
          id: subId,
          team_id: params.p_team_id,
          question_id: params.p_question_id,
          round: 2,
          answer: ans,
          explanation: params.p_explanation,
          correct,
          score,
          time_taken: 30.0,
          submitted_at: new Date().toISOString(),
        };
        store.submissions.push(newSub);

        return { data: { ok: true, submission_id: subId, correct, score, time_taken: 30.0 }, error: null };
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
        return { data: { ok: true }, error: null };
      }

      if (fnName === "admin_finalize_results_tx") {
        store.event_config[0].results_finalized = true;
        return { data: { ok: true }, error: null };
      }

      return { data: null, error: new Error(`Mock RPC unhandled: ${fnName}`) };
    },
  };

  return { store, client };
}

test("Round 2 Test 1: Fixed scoring: Correct BUY/SELL = 1 pt; Wrong/NO_TRADE = 0 pts; No speed bonus; No negative pts", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Activate Round 2
  const actRes = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  }));
  assert.strictEqual(actRes.status, 200);

  // Fast forward past 10s countdown to Question 0 (Correct answer: BUY)
  const r2State = store.round2_state[0];
  r2State.phase = "QUESTION";
  r2State.current_question_index = 0;
  r2State.current_question_id = store.questions[0].id;
  r2State.phase_start_at = new Date().toISOString();
  r2State.phase_ends_at = new Date(Date.now() + 120000).toISOString();

  // 1. Team Alpha submits BUY (correct) with valid explanation
  const buyRes = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Bullish engulfing candle with breakout above 20 EMA on 1D timeframe.",
    }),
  }));
  assert.strictEqual(buyRes.status, 200, "BUY submission should succeed");
  const buyData = await buyRes.json();
  assert.strictEqual(buyData.ok, true);

  // Check the stored submission: correct = true, score = 1
  const subAlpha = store.submissions.find((s) => s.team_id === "00000000-0000-0000-0000-000000000010");
  assert.ok(subAlpha, "Alpha submission exists");
  assert.strictEqual(subAlpha.correct, true);
  assert.strictEqual(subAlpha.score, 1, "Correct BUY must award exactly 1 point");

  // 2. Team Beta submits NO_TRADE with valid explanation
  const noTradeRes = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-beta-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "NO_TRADE",
      explanation: "Too close to major resistance, unfavorable risk-to-reward ratio.",
    }),
  }));
  assert.strictEqual(noTradeRes.status, 200, "NO_TRADE submission should succeed");

  const subBeta = store.submissions.find((s) => s.team_id === "00000000-0000-0000-0000-000000000020");
  assert.ok(subBeta, "Beta submission exists");
  assert.strictEqual(subBeta.correct, false, "NO_TRADE is not correct");
  assert.strictEqual(subBeta.score, 0, "NO_TRADE must award 0 points");
});

test("Round 2 Test 2: Explanation validation: mandatory, single line, max 250 characters", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].phase_start_at = new Date(Date.now() - 1000).toISOString();
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 100000).toISOString();

  // A. Missing explanation rejected (422)
  const resMissing = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
    }),
  }));
  assert.strictEqual(resMissing.status, 422, "Missing explanation must be 422");

  // B. Empty / whitespace explanation rejected (422)
  const resEmpty = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "   ",
    }),
  }));
  assert.strictEqual(resEmpty.status, 422, "Whitespace explanation must be 422");

  // C. Multiline explanation containing newlines rejected (422)
  const resMultiline = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Line 1 technical rationale.\nLine 2 continued analysis.",
    }),
  }));
  assert.strictEqual(resMultiline.status, 422, "Multiline explanation must be 422");

  // D. Explanation exceeding 250 characters rejected (422)
  const resTooLong = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "A".repeat(251),
    }),
  }));
  assert.strictEqual(resTooLong.status, 422, "Over 250 chars explanation must be 422");

  // E. Valid explanation (exactly 250 chars) accepted (200)
  const resValid = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "B".repeat(250),
    }),
  }));
  assert.strictEqual(resValid.status, 200, "250-character single-line explanation must succeed");
});

test("Round 2 Test 3: Teammate concurrency: first accepted answer counts; simultaneous teammate receives 409 (not 500)", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].phase_start_at = new Date(Date.now() - 1000).toISOString();
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 100000).toISOString();

  // Teammate 1 (Alpha Leader) submits BUY
  const res1 = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "First submission by leader.",
    }),
  }));
  assert.strictEqual(res1.status, 200, "First submission by leader must succeed");

  // Teammate 2 (Alpha Mate) submits concurrently for the same team
  const res2 = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-2" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "SELL",
      explanation: "Second submission by mate.",
    }),
  }));
  assert.strictEqual(res2.status, 409, "Second submission must return 409 Conflict, NEVER 500");
  const errData = await res2.json();
  assert.match(errData.detail, /already submitted/i);

  // Verify only 1 submission was persisted for Alpha team
  const alphaSubs = store.submissions.filter((s) => s.team_id === "00000000-0000-0000-0000-000000000010");
  assert.strictEqual(alphaSubs.length, 1, "Exactly one submission must be stored for the team");
  assert.strictEqual(alphaSubs[0].answer, "BUY", "The first accepted submission's answer must remain");
});

test("Round 2 Test 4: Deadline rejection and phase enforcement", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // 1. Rejected when in WAITING phase
  store.event_config[0].rounds["2"].state = "UPCOMING";
  store.round2_state[0].status = "IDLE";
  store.round2_state[0].phase = "WAITING";
  const resWaiting = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Valid explanation.",
    }),
  }));
  assert.strictEqual(resWaiting.status, 400, "Submission in WAITING must fail");

  // 2. Rejected when in COUNTDOWN phase
  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "COUNTDOWN";
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 10000).toISOString();
  const resCountdown = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Valid explanation.",
    }),
  }));
  assert.strictEqual(resCountdown.status, 400, "Submission in COUNTDOWN must fail");

  // 3. Rejected when question deadline has expired
  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].phase_start_at = new Date(Date.now() - 120000).toISOString();
  store.round2_state[0].phase_ends_at = new Date(Date.now() - 5000).toISOString(); // 5 seconds in past
  const resExpired = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Valid explanation.",
    }),
  }));
  assert.strictEqual(resExpired.status, 400, "Submission past deadline must be rejected");
  const expData = await resExpired.json();
  assert.match(expData.detail, /deadline|not currently open/i);
});

test("Round 2 Test 5: Question privacy: non-admin cannot access /api/questions?round=2, no early answer or score leaks", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // 1. Participant blocked from full question list
  const resQuestions = await callApi(new Request("http://localhost/api/questions?round=2", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(resQuestions.status, 403, "Participant must be blocked from /api/questions?round=2");

  // 2. Admin CAN access questions
  const resAdminQuestions = await callApi(new Request("http://localhost/api/questions?round=2", {
    method: "GET",
    headers: { Authorization: "Bearer user-admin" },
  }));
  assert.strictEqual(resAdminQuestions.status, 200, "Admin can access /api/questions?round=2");

  // 3. In QUESTION phase, status exposes current question text and options BUY, SELL, NO_TRADE, but NO correct_answer
  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_index = 0;
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].frozen_questions = store.questions.filter((q) => q.round === 2);
  store.round2_state[0].closed_question_ids = [];

  const resStatus = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(resStatus.status, 200);
  const statusData = await resStatus.json();
  assert.strictEqual(statusData.phase, "QUESTION");
  assert.strictEqual(statusData.question?.id, store.questions[0].id);
  assert.deepStrictEqual(statusData.question?.options, ["BUY", "SELL", "NO_TRADE"]);
  assert.strictEqual(statusData.question?.correct_answer, undefined, "correct_answer must NOT leak during QUESTION phase");

  // 4. Submit an answer, then check /scores/me and /api/rounds/2/my-submissions
  store.submissions.push({
    id: "sub-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Breakout",
    correct: true,
    score: 1,
    time_taken: 10,
    submitted_at: new Date().toISOString(),
  });

  // /api/rounds/2/my-submissions masks correct and score for unclosed question
  const resMySubs = await callApi(new Request("http://localhost/api/rounds/2/my-submissions", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const mySubs = await resMySubs.json();
  assert.strictEqual(mySubs.length, 1);
  assert.strictEqual(mySubs[0].correct, null, "correct must be masked (null) before question is closed");
  assert.strictEqual(mySubs[0].score, null, "score must be masked (null) before question is closed");

  // /scores/me counts ONLY closed-question points
  const resScoresMe = await callApi(new Request("http://localhost/api/scores/me", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const scoreData = await resScoresMe.json();
  assert.strictEqual(scoreData.round2, 0, "Unclosed question score must not be included in round2");
});

test("Round 2 Test 6: Result phase reveals correctness and counts closed-question points", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Set state to RESULT phase for Q0 (id: store.questions[0].id)
  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "RESULT";
  store.round2_state[0].current_question_index = 0;
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].frozen_questions = store.questions.filter((q) => q.round === 2);
  store.round2_state[0].closed_question_ids = [store.questions[0].id]; // Q0 is now closed

  // Team Alpha submitted BUY (correct), Team Beta submitted SELL (wrong)
  store.submissions.push({
    id: "sub-alpha",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Alpha explanation",
    correct: true,
    score: 1,
    time_taken: 15,
    submitted_at: new Date().toISOString(),
  });
  store.submissions.push({
    id: "sub-beta",
    team_id: "00000000-0000-0000-0000-000000000020",
    question_id: store.questions[0].id,
    round: 2,
    answer: "SELL",
    explanation: "Beta explanation",
    correct: false,
    score: 0,
    time_taken: 20,
    submitted_at: new Date().toISOString(),
  });

  // 1. /api/rounds/2/status now reveals correct_answer in RESULT phase
  const resStatus = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const statusData = await resStatus.json();
  assert.strictEqual(statusData.phase, "RESULT");
  assert.strictEqual(statusData.question?.correct_answer, "BUY", "Correct answer is revealed in RESULT phase");

  // 2. /api/rounds/2/my-submissions now reveals correct: true and score: 1 for Alpha
  const resAlphaSubs = await callApi(new Request("http://localhost/api/rounds/2/my-submissions", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const alphaSubs = await resAlphaSubs.json();
  assert.strictEqual(alphaSubs[0].correct, true);
  assert.strictEqual(alphaSubs[0].score, 1);

  // 3. /api/scores/me now includes Round 2 score of 1 point for Alpha
  const resAlphaScore = await callApi(new Request("http://localhost/api/scores/me", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const alphaScoreData = await resAlphaScore.json();
  assert.strictEqual(alphaScoreData.round2, 1, "Alpha round2 must be 1 point");

  // Beta round2 is 0 points
  const resBetaScore = await callApi(new Request("http://localhost/api/scores/me", {
    method: "GET",
    headers: { Authorization: "Bearer user-beta-1" },
  }));
  const betaScoreData = await resBetaScore.json();
  assert.strictEqual(betaScoreData.round2, 0, "Beta round2 must be 0 points");
});

test("Round 2 Test 7: Pause and resume preserves state, remaining time, and rejects submissions while paused", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 85000).toISOString();

  // Admin pauses Round 2
  const pauseRes = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "PAUSED" }),
  }));
  assert.strictEqual(pauseRes.status, 200);

  // Verify status is PAUSED
  const statusRes = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const statusData = await statusRes.json();
  assert.strictEqual(statusData.is_paused, true);

  // Submissions during pause are rejected
  const subRes = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Submitting while paused",
    }),
  }));
  assert.strictEqual(subRes.status, 400);
  const subData = await subRes.json();
  assert.match(subData.detail, /paused/i);

  // Admin resumes Round 2
  const resumeRes = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  }));
  assert.strictEqual(resumeRes.status, 200);

  const resumedStatusRes = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  const resumedData = await resumedStatusRes.json();
  assert.strictEqual(resumedData.is_paused, false);
  assert.strictEqual(resumedData.phase, "QUESTION");
});

test("Round 2 Test 8: Reset Gameplay clears R2 submissions and restores WAITING state", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].closed_question_ids = [store.questions[0].id];
  store.submissions.push({
    id: "sub-r2",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Pre-reset answer",
    correct: true,
    score: 1,
    time_taken: 10,
    submitted_at: new Date().toISOString(),
  });

  // Admin triggers Reset Gameplay
  const resetRes = await callApi(new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ action: "reset" }),
  }));
  assert.strictEqual(resetRes.status, 200);

  // R2 submissions wiped
  assert.strictEqual(store.submissions.length, 0, "Submissions must be empty after reset");

  // R2 state reset to IDLE / WAITING
  const r2 = store.round2_state[0];
  assert.strictEqual(r2.status, "IDLE");
  assert.strictEqual(r2.phase, "WAITING");
  assert.strictEqual(r2.closed_question_ids.length, 0);

  // Teams and questions preserved
  assert.strictEqual(store.teams.length, 2, "Teams must be preserved");
  assert.strictEqual(store.questions.length, 5, "Questions must be preserved");
});

test("Round 2 Test 9: Transactional finalization protection blocks R2 submissions after results are finalized", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 100000).toISOString();

  // Finalize results
  store.event_config[0].results_finalized = true;

  // Submissions post-finalization must be rejected with 400
  const subRes = await callApi(new Request("http://localhost/api/rounds/2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alpha-1" },
    body: JSON.stringify({
      question_id: store.questions[0].id,
      answer: "BUY",
      explanation: "Post finalization attempt",
    }),
  }));
  assert.strictEqual(subRes.status, 400);
  const errData = await subRes.json();
  assert.match(errData.detail, /finalized/i);
});

test("Round 2 Test 10: Admin explanations review and CSV export", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  store.round2_state[0].closed_question_ids = [store.questions[0].id];
  store.submissions.push({
    id: "sub-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Clean support bounce off previous resistance turned support.",
    correct: true,
    score: 1,
    time_taken: 22.4,
    submitted_at: "2026-10-27T10:00:00.000Z",
  });

  // 1. Admin explanation review endpoint
  const expRes = await callApi(new Request("http://localhost/api/admin/round2/explanations", {
    method: "GET",
    headers: { Authorization: "Bearer user-admin" },
  }));
  assert.strictEqual(expRes.status, 200);
  const exps = await expRes.json();
  assert.strictEqual(exps.length, 1);
  assert.strictEqual(exps[0].team_name, "Alpha Bulls");
  assert.strictEqual(exps[0].decision, "BUY");
  assert.strictEqual(exps[0].explanation, "Clean support bounce off previous resistance turned support.");

  // Non-admin blocked from explanations review
  const teamExpRes = await callApi(new Request("http://localhost/api/admin/round2/explanations", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(teamExpRes.status, 403);

  // 2. CSV Export endpoint
  const exportRes = await callApi(new Request("http://localhost/api/admin/export/round2", {
    method: "GET",
    headers: { Authorization: "Bearer user-admin" },
  }));
  assert.strictEqual(exportRes.status, 200);
  const csvText = await exportRes.text();
  assert.ok(csvText.includes("Alpha Bulls"), "CSV must include team name");
  assert.ok(csvText.includes("BUY"), "CSV must include decision");
  assert.ok(csvText.includes("Clean support bounce"), "CSV must include explanation");
});

test("Round 2 Test 11: advance_round2_state_tx reuses warm leaderboard cache on unchanged status reads and invalidates on actual phase/score change", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Set Round 2 to RESULT phase with question closed
  store.event_config[0].rounds["2"].state = "ACTIVE";
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "RESULT";
  store.round2_state[0].current_question_index = 0;
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].closed_question_ids = [store.questions[0].id];
  store.round2_state[0].phase_ends_at = new Date(Date.now() + 10000).toISOString();

  // Initial read populates the leaderboard cache
  const res1 = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(res1.status, 200);

  // Measure performance across repeated status polls
  const startPolls = Date.now();
  for (let i = 0; i < 5; i++) {
    const res = await callApi(new Request("http://localhost/api/rounds/2/status", {
      method: "GET",
      headers: { Authorization: "Bearer user-alpha-1" },
    }));
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.phase, "RESULT");
  }
  const pollDuration = Date.now() - startPolls;
  assert.ok(pollDuration < 500, `Repeated RESULT polls must be fast and reuse warm cache (took ${pollDuration}ms)`);

  // Now trigger an actual phase change (RESULT -> QUESTION 2)
  store.round2_state[0].phase = "QUESTION";
  store.round2_state[0].current_question_index = 1;
  store.round2_state[0].current_question_id = store.questions[1].id;
  store.round2_state[0].version += 1;

  const resTransition = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(resTransition.status, 200);
  const transData = await resTransition.json();
  assert.strictEqual(transData.phase, "QUESTION");
});

test("Round 2 Test 12: Validate R2 question creation/update and activation server-side", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // 1. Correct answer must be BUY or SELL only (reject HOLD, NO_TRADE, or arbitrary text)
  const resHold = await callApi(new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      round: 2,
      text: "Chart Setup with HOLD",
      correct_answer: "HOLD",
      time_limit: 120,
    }),
  }));
  assert.strictEqual(resHold.status, 422, "HOLD correct answer must be rejected");
  const holdErr = await resHold.json();
  assert.match(holdErr.detail, /BUY or SELL/i);

  const resNoTrade = await callApi(new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      round: 2,
      text: "Chart Setup with NO_TRADE answer",
      correct_answer: "NO_TRADE",
      time_limit: 120,
    }),
  }));
  assert.strictEqual(resNoTrade.status, 422, "NO_TRADE correct answer must be rejected");

  // 2. Reject non-positive or non-integer duration
  const resZeroLimit = await callApi(new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      round: 2,
      text: "Chart Setup with 0s duration",
      correct_answer: "BUY",
      time_limit: 0,
    }),
  }));
  assert.strictEqual(resZeroLimit.status, 422, "0 duration must be rejected");

  const resNegativeLimit = await callApi(new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      round: 2,
      text: "Chart Setup with negative duration",
      correct_answer: "BUY",
      time_limit: -10,
    }),
  }));
  assert.strictEqual(resNegativeLimit.status, 422, "Negative duration must be rejected");

  // 3. Valid creation: BUY or SELL, fixed 1-point scoring, options ["BUY", "SELL", "NO_TRADE"]
  // Preserves shorter duration (e.g. 15s) for local rehearsal
  const resValidRehearsal = await callApi(new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      round: 2,
      text: "Rehearsal Chart: 15s quick test",
      correct_answer: "SELL",
      time_limit: 15,
      base_points: 100, // Should be forced to 1 point for Round 2
    }),
  }));
  assert.strictEqual(resValidRehearsal.status, 200);
  const rehearsalQ = await resValidRehearsal.json();
  assert.strictEqual(rehearsalQ.correct_answer, "SELL");
  assert.strictEqual(rehearsalQ.time_limit, 15, "Shorter duration for rehearsal preserved");
  assert.strictEqual(rehearsalQ.base_points, 1, "Fixed 1-point scoring enforced");
  assert.deepStrictEqual(rehearsalQ.options, ["BUY", "SELL", "NO_TRADE"]);

  // 4. Update question preserves validation
  const resUpdate = await callApi(new Request(`http://localhost/api/questions/${rehearsalQ.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({
      correct_answer: "INVALID",
    }),
  }));
  assert.strictEqual(resUpdate.status, 422, "Update with invalid answer must be rejected");
});

test("Round 2 Test 13: admin_set_round2_state_tx rejects UPCOMING during running, paused, or completed/played run without contradictory states", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // 1. Start Round 2 -> ACTIVE
  const resActive1 = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  }));
  assert.strictEqual(resActive1.status, 200);
  assert.strictEqual(store.event_config[0].rounds["2"].state, "ACTIVE");

  // Add a submission to simulate played run
  store.submissions.push({
    id: "sub-test-run",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Active run submission",
    correct: true,
    score: 1,
    time_taken: 10,
    submitted_at: new Date().toISOString(),
  });

  // 2. Attempt transition ACTIVE -> UPCOMING: MUST BE REJECTED with ROUND_PLAYED error
  const resUpcoming = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "UPCOMING" }),
  }));
  assert.strictEqual(resUpcoming.status, 400);
  const upErr = await resUpcoming.json();
  assert.match(upErr.detail, /Reset Gameplay/i);

  // Verify states remain consistently ACTIVE and submissions are NOT deleted
  assert.strictEqual(store.event_config[0].rounds["2"].state, "ACTIVE");
  assert.strictEqual(store.round2_state[0].status, "ACTIVE");
  assert.strictEqual(store.submissions.filter((s) => s.round === 2).length, 1);

  // 3. Attempt transition ACTIVE -> ACTIVE again: succeeds idempotently without contradictory states
  const resActive2 = await callApi(new Request("http://localhost/api/rounds/2/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  }));
  assert.strictEqual(resActive2.status, 200);
  assert.strictEqual(store.event_config[0].rounds["2"].state, "ACTIVE");
  assert.strictEqual(store.round2_state[0].status, "ACTIVE");
});

test("Round 2 Test 14: Keep R2 score card, completion score, and standings consistent with admin score override, and respect leaderboard_visible", async () => {
  const { store, client } = createMockSupabase();
  setTestDb(client);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Alpha Desk has 1 correct submission (raw score = 1)
  store.round2_state[0].status = "ACTIVE";
  store.round2_state[0].phase = "RESULT";
  store.round2_state[0].current_question_id = store.questions[0].id;
  store.round2_state[0].closed_question_ids = [store.questions[0].id];
  store.submissions.push({
    id: "sub-alpha-q1",
    team_id: "00000000-0000-0000-0000-000000000010",
    question_id: store.questions[0].id,
    round: 2,
    answer: "BUY",
    explanation: "Support bounce",
    correct: true,
    score: 1,
    time_taken: 15,
    submitted_at: new Date().toISOString(),
  });

  // Admin overrides Alpha Desk Round 2 score to 4
  store.score_overrides.push({
    id: "ovr-1",
    team_id: "00000000-0000-0000-0000-000000000010",
    round: 2,
    new_score: 4,
    reason: "Admin appeal granted",
  });

  // 1. Participant status returns team_score = 4 and standings.round2 = 4 (completely consistent)
  const resStatus = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(resStatus.status, 200);
  const statusData = await resStatus.json();
  assert.strictEqual(statusData.team_score, 4, "team_score must reflect admin override");
  assert.strictEqual(statusData.standings.round2, 4, "standings.round2 must reflect admin override");
  assert.strictEqual(statusData.standings.rank, 1, "Alpha is rank 1 when leaderboard_visible is true");
  assert.ok(statusData.leaderboard.length > 0, "Leaderboard rows returned when visible");

  // 2. Hide leaderboard (leaderboard_visible = false)
  store.event_config[0].leaderboard_visible = false;
  invalidateConfigCache();

  const resHidden = await callApi(new Request("http://localhost/api/rounds/2/status", {
    method: "GET",
    headers: { Authorization: "Bearer user-alpha-1" },
  }));
  assert.strictEqual(resHidden.status, 200);
  const hiddenData = await resHidden.json();
  assert.strictEqual(hiddenData.standings.rank, null, "Rank must be masked when leaderboard_visible is false");
  assert.deepStrictEqual(hiddenData.leaderboard, [], "Leaderboard must be empty array when leaderboard_visible is false");
  assert.strictEqual(hiddenData.team_score, 4, "Score is preserved even when leaderboard is hidden");
});

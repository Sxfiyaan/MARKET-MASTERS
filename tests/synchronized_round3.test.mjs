import test from "node:test";
import assert from "node:assert/strict";

import {
  handle,
  all,
  computeTradePerformanceScore,
  computeTradeRiskScore,
  computeTradeScore,
  computeScores,
  scores,
  getRound3State,
  advanceRound3State,
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
  const store = {
    round1_state: [
      {
        id: "current",
        version: 1,
        status: "COMPLETED",
        phase: "COMPLETED",
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
        closed_question_ids: [],
        frozen_questions: null,
        speed_bonus_pct: 0.5,
      },
    ],
    round2_state: [
      {
        id: "current",
        version: 1,
        status: "COMPLETED",
        phase: "COMPLETED",
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
        closed_question_ids: [],
        frozen_questions: null,
      },
    ],
    round3_state: [
      {
        id: "current",
        version: 1,
        status: "IDLE",
        phase: "WAITING",
        round_duration_minutes: 90,
        phase_start_at: null,
        phase_ends_at: null,
        is_paused: false,
        paused_at: null,
        paused_remaining_ms: 0,
        updated_at: new Date().toISOString(),
      },
    ],
    event_config: [
      {
        id: "event",
        name: "Market Masters",
        registration_open: true,
        leaderboard_visible: true,
        results_finalized: false,
        round1_weight: 30,
        round2_weight: 30,
        round3_weight: 40,
        starting_capital: 100000,
        max_trades: 2,
        max_risk_per_trade: 2,
        round3_duration_minutes: 90,
        rounds: {
          1: { state: "COMPLETED" },
          2: { state: "COMPLETED" },
          3: { state: "UPCOMING" },
        },
      },
    ],
    teams: [
      { id: "team-1", team_name: "Alpha Desk", college: "Finance Institute", leader_name: "Alice", leader_email: "alice@test.com", leader_phone: "9876543210" },
      { id: "team-2", team_name: "Beta Traders", college: "Commerce College", leader_name: "Bob", leader_email: "bob@test.com", leader_phone: "9876543211" },
    ],
    profiles: [
      { id: "user-alice", email: "alice@test.com", role: "team", team_id: "team-1", name: "Alice" },
      { id: "user-teammate", email: "teammate@test.com", role: "team", team_id: "team-1", name: "Alice Teammate" },
      { id: "user-bob", email: "bob@test.com", role: "team", team_id: "team-2", name: "Bob" },
      { id: "user-admin", email: "admin@test.com", role: "admin", team_id: null, name: "Organizer" },
    ],
    submissions: [],
    trades: [],
    score_overrides: [],
    leaderboard_snapshot: [],
    audit_logs: [],
    ...initialData,
  };

  const client = {
    _store: store,
    auth: {
      getUser: async (token) => {
        const profile = store.profiles.find((p) => p.id === token || p.email === token);
        if (profile) return { data: { user: { id: profile.id, email: profile.email } }, error: null };
        return { data: { user: null }, error: new Error("Invalid session") };
      },
    },
    from(table) {
      const rows = store[table] || [];
      let filtered = [...rows];
      const queryObj = {
        select(cols = "*") {
          return queryObj;
        },
        eq(col, val) {
          filtered = filtered.filter((r) => r[col] === val);
          return queryObj;
        },
        neq(col, val) {
          filtered = filtered.filter((r) => r[col] !== val);
          return queryObj;
        },
        order(col, { ascending = true } = {}) {
          filtered.sort((a, b) => {
            if (a[col] < b[col]) return ascending ? -1 : 1;
            if (a[col] > b[col]) return ascending ? 1 : -1;
            return 0;
          });
          return queryObj;
        },
        range(from, to) {
          filtered = filtered.slice(from, to + 1);
          return queryObj;
        },
        async single() {
          if (!filtered.length) return { data: null, error: { message: "Not found", code: "PGRST116" } };
          return { data: { ...filtered[0] }, error: null };
        },
        async maybeSingle() {
          if (!filtered.length) return { data: null, error: null };
          return { data: { ...filtered[0] }, error: null };
        },
        async delete() {
          const removed = [];
          store[table] = (store[table] || []).filter((r) => {
            const matches = filtered.includes(r);
            if (matches) removed.push(r);
            return !matches;
          });
          return { data: removed, error: null };
        },
        async insert(values) {
          const toInsert = Array.isArray(values) ? values : [values];
          const inserted = toInsert.map((item, idx) => ({
            id: item.id || `gen-${Date.now()}-${idx}-${Math.random()}`,
            created_at: new Date().toISOString(),
            ...item,
          }));
          store[table] = [...(store[table] || []), ...inserted];
          return { data: Array.isArray(values) ? inserted : inserted[0], error: null };
        },
        async update(values) {
          const updated = [];
          store[table] = (store[table] || []).map((r) => {
            if (filtered.some((f) => f.id === r.id)) {
              const merged = { ...r, ...values };
              updated.push(merged);
              return merged;
            }
            return r;
          });
          return { data: updated, error: null };
        },
        then(onfulfilled, onrejected) {
          return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(onfulfilled, onrejected);
        },
      };
      return queryObj;
    },

    async rpc(fnName, args = {}) {
      if (fnName === "admin_set_round3_state_tx") {
        const action = args.p_action;
        const nowIso = args.p_now || new Date().toISOString();
        const r3 = store.round3_state[0];
        const cfg = store.event_config[0];

        if (action === "UPCOMING") {
          const hasTrades = store.trades.length > 0;
          if (r3.status === "ACTIVE" || r3.status === "PAUSED" || hasTrades || cfg.rounds?.["3"]?.state === "ACTIVE" || cfg.rounds?.["3"]?.state === "COMPLETED") {
            return {
              data: {
                ok: false,
                error: "Cannot set Round 3 to UPCOMING during a running, paused, or completed/played run. Use Reset Gameplay to wipe gameplay data.",
                code: "CONTRADICTORY_STATE",
              },
              error: null,
            };
          }
          r3.status = "IDLE";
          r3.phase = "WAITING";
          r3.round_duration_minutes = args.p_duration_minutes || 90;
          r3.phase_start_at = null;
          r3.phase_ends_at = null;
          r3.is_paused = false;
          r3.paused_remaining_ms = 0;
          r3.version += 1;
          cfg.rounds["3"] = { state: "UPCOMING", started_at: null, ended_at: null };
          return { data: { ok: true, round_value: cfg.rounds["3"], r3_state: r3 }, error: null };
        }

        if (action === "ACTIVE") {
          if (r3.is_paused) {
            const rem = Math.max(0, r3.paused_remaining_ms || 0);
            r3.is_paused = false;
            r3.paused_remaining_ms = 0;
            r3.phase_ends_at = new Date(Date.now() + rem).toISOString();
            r3.status = "ACTIVE";
            r3.phase = "ACTIVE";
            r3.version += 1;
          } else {
            const durMin = args.p_duration_minutes || r3.round_duration_minutes || 90;
            const start = new Date(nowIso);
            const end = new Date(start.getTime() + durMin * 60000);
            r3.status = "ACTIVE";
            r3.phase = "ACTIVE";
            r3.round_duration_minutes = durMin;
            r3.phase_start_at = start.toISOString();
            r3.phase_ends_at = end.toISOString();
            r3.is_paused = false;
            r3.paused_remaining_ms = 0;
            r3.version += 1;
          }
          cfg.rounds["3"] = { state: "ACTIVE", started_at: r3.phase_start_at, ended_at: null };
          return { data: { ok: true, round_value: cfg.rounds["3"], r3_state: r3 }, error: null };
        }

        if (action === "PAUSED") {
          if ((r3.status === "ACTIVE" || r3.phase === "ACTIVE") && !r3.is_paused) {
            const rem = Math.max(0, new Date(r3.phase_ends_at).getTime() - Date.now());
            r3.is_paused = true;
            r3.paused_remaining_ms = rem;
            r3.status = "PAUSED";
            r3.phase = "PAUSED";
            r3.version += 1;
          }
          cfg.rounds["3"].state = "PAUSED";
          return { data: { ok: true, round_value: cfg.rounds["3"], r3_state: r3 }, error: null };
        }

        if (action === "COMPLETED") {
          r3.status = "COMPLETED";
          r3.phase = "COMPLETED";
          r3.is_paused = false;
          r3.paused_remaining_ms = 0;
          r3.version += 1;
          cfg.rounds["3"] = { state: "COMPLETED", started_at: r3.phase_start_at, ended_at: nowIso };
          return { data: { ok: true, round_value: cfg.rounds["3"], r3_state: r3 }, error: null };
        }
      }

      if (fnName === "advance_round3_state_tx") {
        const r3 = store.round3_state[0];
        const cfg = store.event_config[0];
        const now = Date.now();
        if (r3.status === "ACTIVE" && !r3.is_paused && r3.phase_ends_at && new Date(r3.phase_ends_at).getTime() <= now) {
          r3.status = "COMPLETED";
          r3.phase = "COMPLETED";
          r3.is_paused = false;
          r3.paused_remaining_ms = 0;
          r3.version += 1;
          if (cfg.rounds?.["3"]) {
            cfg.rounds["3"].state = "COMPLETED";
            cfg.rounds["3"].ended_at = new Date().toISOString();
          }
        }
        return { data: { ...r3 }, error: null };
      }

      if (fnName === "submit_round3_trade_tx") {
        const cfg = store.event_config[0];
        const r3 = store.round3_state[0];
        const teamId = args.p_team_id;

        if (cfg.results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Submissions are closed.", code: "FINALIZED" }, error: null };
        }
        if (r3.is_paused || cfg.rounds?.["3"]?.state === "PAUSED" || r3.status === "PAUSED") {
          return { data: { ok: false, error: "Round 3 is paused", code: "ROUND_PAUSED" }, error: null };
        }
        if (cfg.rounds?.["3"]?.state !== "ACTIVE" || r3.status !== "ACTIVE" || r3.phase !== "ACTIVE") {
          return { data: { ok: false, error: "Round 3 is not active", code: "NOT_ACTIVE" }, error: null };
        }
        if (!r3.phase_ends_at || new Date(r3.phase_ends_at).getTime() <= Date.now()) {
          return { data: { ok: false, error: "Round 3 window has closed", code: "DEADLINE_EXPIRED" }, error: null };
        }

        const teamTrades = store.trades.filter((t) => t.team_id === teamId);
        let tradeNumber = args.p_trade_number;

        if (tradeNumber != null) {
          if (![1, 2].includes(Number(tradeNumber))) {
            return { data: { ok: false, error: "Invalid trade slot number (must be 1 or 2)", code: "INVALID_SLOT" }, error: null };
          }
          const existing = teamTrades.find((t) => Number(t.trade_number) === Number(tradeNumber));
          if (existing) {
            return { data: { ok: false, error: `Trade ${tradeNumber} already submitted`, code: "SLOT_ALREADY_USED", trade: existing }, error: null };
          }
        } else {
          if (teamTrades.length >= 2) {
            return { data: { ok: false, error: "Trade limit reached (2 trades maximum)", code: "TRADE_LIMIT" }, error: null };
          }
          const usedSlots = new Set(teamTrades.map((t) => Number(t.trade_number)));
          tradeNumber = !usedSlots.has(1) ? 1 : !usedSlots.has(2) ? 2 : null;
          if (!tradeNumber) {
            return { data: { ok: false, error: "Trade limit reached (2 trades maximum)", code: "TRADE_LIMIT" }, error: null };
          }
        }

        const newTrade = {
          id: `trade-${Date.now()}-${Math.random()}`,
          team_id: teamId,
          trade_number: tradeNumber,
          asset: args.p_asset,
          account_size: Number(args.p_account_size),
          risk_per_trade: Number(args.p_risk_per_trade),
          result_type: args.p_result_type,
          profit: Number(args.p_profit || 0),
          loss: Number(args.p_loss || 0),
          pl_percentage: Number(args.p_pl_percentage),
          proof_url: args.p_proof_url || null,
          verification_status: "PENDING",
          admin_notes: null,
          submitted_at: new Date().toISOString(),
        };

        store.trades.push(newTrade);
        return { data: { ok: true, trade: newTrade }, error: null };
      }

      if (fnName === "admin_verify_trade_tx") {
        const cfg = store.event_config[0];
        if (cfg.results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before modifying trades.", code: "FINALIZED" }, error: null };
        }
        const trade = store.trades.find((t) => t.id === args.p_trade_id);
        if (!trade) {
          return { data: { ok: false, error: "Trade not found", code: "NOT_FOUND" }, error: null };
        }
        trade.verification_status = args.p_status;
        trade.admin_notes = args.p_reason || null;
        return { data: { ok: true, trade }, error: null };
      }

      if (fnName === "admin_delete_trade_tx") {
        const cfg = store.event_config[0];
        if (cfg.results_finalized) {
          return { data: { ok: false, error: "Results are finalized. Reopen results before deleting trades.", code: "FINALIZED" }, error: null };
        }
        const idx = store.trades.findIndex((t) => t.id === args.p_trade_id);
        if (idx === -1) {
          return { data: { ok: false, error: "Trade not found", code: "NOT_FOUND" }, error: null };
        }
        const deleted = store.trades.splice(idx, 1)[0];
        return { data: { ok: true, trade: deleted }, error: null };
      }

      if (fnName === "admin_finalize_results_tx") {
        const pending = store.trades.filter((t) => t.verification_status === "PENDING");
        if (pending.length > 0) {
          return {
            data: {
              ok: false,
              error: `Cannot finalize results: ${pending.length} Round 3 trade(s) are pending review.`,
              code: "PENDING_TRADES_EXIST",
            },
            error: null,
          };
        }
        store.event_config[0].results_finalized = true;
        return { data: { ok: true, message: "Results finalized successfully." }, error: null };
      }

      if (fnName === "admin_reset_gameplay_tx") {
        store.submissions = [];
        store.trades = [];
        store.score_overrides = [];
        store.leaderboard_snapshot = [];
        store.event_config[0].results_finalized = false;
        store.event_config[0].rounds = {
          1: { state: "UPCOMING", started_at: null, ended_at: null },
          2: { state: "UPCOMING", started_at: null, ended_at: null },
          3: { state: "UPCOMING", started_at: null, ended_at: null },
        };
        store.round3_state[0] = {
          id: "current",
          version: store.round3_state[0].version + 1,
          status: "IDLE",
          phase: "WAITING",
          round_duration_minutes: 90,
          phase_start_at: null,
          phase_ends_at: null,
          is_paused: false,
          paused_at: null,
          paused_remaining_ms: 0,
          updated_at: new Date().toISOString(),
        };
        return { data: { ok: true, round3_state: store.round3_state[0] }, error: null };
      }

      throw new Error(`Unhandled mock RPC: ${fnName}`);
    },
  };

  return client;
}

test("1. Scoring: computeTradePerformanceScore converts P/L% linearly [0, 1000]", () => {
  // Formula: Math.max(0, Math.min(1, (pl + 5) / 15)) * 1000
  // P/L = -5% -> 0
  assert.equal(computeTradePerformanceScore(-5), 0);
  assert.equal(computeTradePerformanceScore(-10), 0); // clamped lower bound

  // P/L = +10% -> 1000
  assert.equal(computeTradePerformanceScore(10), 1000);
  assert.equal(computeTradePerformanceScore(15), 1000); // clamped upper bound

  // P/L = 0% -> (0 + 5)/15 * 1000 = 333.333...
  const zeroPl = computeTradePerformanceScore(0);
  assert.ok(Math.abs(zeroPl - 333.33) < 0.1);

  // P/L = +2.5% -> (2.5 + 5)/15 * 1000 = 500
  assert.equal(computeTradePerformanceScore(2.5), 500);
});

test("2. Scoring: Risk > 50% penalty threshold versus <= 50%", () => {
  // max_risk = 2%
  // Formula:
  // Base 1000
  // if risk > 50 -> -300
  // else if risk <= maxRisk / 2 (1%) -> +100
  // else -> +50
  // if loss < -1.5 * maxRisk (-3%) -> -200

  // A: Exactly 50% risk with +1% profit:
  // riskPct > 50 is FALSE! Exactly 50 does NOT trigger -300 penalty.
  // 50 > 1, so gets +50. Total = 1050 clamped to 1000.
  const risk50Score = computeTradeRiskScore(50.0, 1.0, 2);
  assert.equal(risk50Score, 1000);

  // B: Risk 50.1% (> 50%) with +1% profit:
  // riskPct > 50 is TRUE! Triggers -300 penalty.
  // Base 1000 - 300 = 700.
  const risk501Score = computeTradeRiskScore(50.1, 1.0, 2);
  assert.equal(risk501Score, 700);

  // C: Low risk <= 1% with +2% profit:
  // Base 1000 + 100 = 1100 clamped to 1000.
  assert.equal(computeTradeRiskScore(1.0, 2.0, 2), 1000);

  // D: Risk 50.1% AND loss < -3% (e.g. -4% loss):
  // 1000 - 300 (risk > 50) - 200 (loss > 1.5x max_risk) = 500.
  assert.equal(computeTradeRiskScore(55, -4.0, 2), 500);

  // E: Risk 1.5% and loss < -3% (e.g. -4% loss):
  // 1000 + 50 - 200 = 850.
  assert.equal(computeTradeRiskScore(1.5, -4.0, 2), 850);
});

test("3. Scoring: 60/40 trade formula and equal two-trade averaging", () => {
  // trade_score = 0.60 * performance + 0.40 * risk
  const cfg = { max_risk_per_trade: 2 };

  // Trade 1: pl = 10% (perf = 1000), risk = 1% (risk score = 1000)
  // Trade 1 score = 0.60 * 1000 + 0.40 * 1000 = 1000
  const t1 = { pl_percentage: 10, risk_per_trade: 1 };
  const calc1 = computeTradeScore(t1, cfg);
  assert.equal(calc1.performance, 1000);
  assert.equal(calc1.risk, 1000);
  assert.equal(calc1.total, 1000);

  // Trade 2: pl = 2.5% (perf = 500), risk = 55% (>50 penalty -> risk score = 700)
  // Trade 2 score = 0.60 * 500 + 0.40 * 700 = 300 + 280 = 580
  const t2 = { pl_percentage: 2.5, risk_per_trade: 55 };
  const calc2 = computeTradeScore(t2, cfg);
  assert.equal(calc2.performance, 500);
  assert.equal(calc2.risk, 700);
  assert.equal(calc2.total, 580);

  // R3 raw score with both trades verified:
  // (1000 + 580) / 2 = 790
  const avg = (calc1.total + calc2.total) / 2;
  assert.equal(avg, 790);
});

test("4. Authoritative shared 90-minute round, late join, and pause/resume", async () => {
  const mockDb = createMockSupabase();
  setTestDb(mockDb);
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Admin starts Round 3
  const startReq = new Request("http://localhost/api/rounds/3/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  });
  const startRes = await callApi(startReq);
  assert.equal(startRes.status, 200);

  // Team 1 checks status
  const t1Req = new Request("http://localhost/api/rounds/3/status", {
    headers: { Authorization: "Bearer user-alice" },
  });
  const t1Res = await callApi(t1Req);
  const t1Data = await t1Res.json();
  assert.equal(t1Data.round_state, "ACTIVE");
  assert.equal(t1Data.is_paused, false);
  assert.ok(t1Data.phase_ends_at);
  assert.ok(t1Data.time_left > 5300); // 90 min = 5400s

  // Team 2 (late joiner) checks status
  const t2Req = new Request("http://localhost/api/rounds/3/status", {
    headers: { Authorization: "Bearer user-bob" },
  });
  const t2Res = await callApi(t2Req);
  const t2Data = await t2Res.json();
  // Late joiner MUST have identical shared phase_ends_at
  assert.equal(t2Data.phase_ends_at, t1Data.phase_ends_at);

  // Calling legacy /rounds/3/start does NOT extend personal clock
  const legacyReq = new Request("http://localhost/api/rounds/3/start", {
    method: "POST",
    headers: { Authorization: "Bearer user-bob" },
  });
  const legacyRes = await callApi(legacyReq);
  assert.equal(legacyRes.status, 200);
  const legacyData = await legacyRes.json();
  assert.equal(legacyData.ends_at, t1Data.phase_ends_at);

  // Organizer Pauses Round 3
  const pauseReq = new Request("http://localhost/api/rounds/3/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "PAUSED" }),
  });
  const pauseRes = await callApi(pauseReq);
  assert.equal(pauseRes.status, 200);

  // Submission while paused is REJECTED
  const subPausedReq = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "BTC/USDT",
      account_size: 100000,
      risk_per_trade: 1.5,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 1,
    }),
  });
  const subPausedRes = await callApi(subPausedReq);
  assert.equal(subPausedRes.status, 400);
  const subPausedJson = await subPausedRes.json();
  assert.match(subPausedJson.detail, /paused/i);

  // Resume Round 3
  const resumeReq = new Request("http://localhost/api/rounds/3/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ state: "ACTIVE" }),
  });
  const resumeRes = await callApi(resumeReq);
  assert.equal(resumeRes.status, 200);
});

test("5. Input validation: profit/loss coherence and finite values", async () => {
  const mockDb = createMockSupabase();
  setTestDb(mockDb);
  mockDb._store.round3_state[0].status = "ACTIVE";
  mockDb._store.round3_state[0].phase = "ACTIVE";
  mockDb._store.round3_state[0].phase_ends_at = new Date(Date.now() + 3600000).toISOString();
  mockDb._store.event_config[0].rounds["3"].state = "ACTIVE";
  invalidateConfigCache();

  // Test A: PROFIT with negative P/L% -> rejected
  const reqA = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "XAU/USD",
      account_size: 100000,
      risk_per_trade: 1.5,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: -2.0,
      trade_number: 1,
    }),
  });
  const resA = await callApi(reqA);
  assert.equal(resA.status, 400);

  // Test B: LOSS with positive P/L% -> rejected
  const reqB = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "XAU/USD",
      account_size: 100000,
      risk_per_trade: 1.5,
      result_type: "LOSS",
      profit: 0,
      loss: 2000,
      pl_percentage: 2.0,
      trade_number: 1,
    }),
  });
  const resB = await callApi(reqB);
  assert.equal(resB.status, 400);

  // Test C: Negative risk -> rejected
  const reqC = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "XAU/USD",
      account_size: 100000,
      risk_per_trade: -1,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 1,
    }),
  });
  const resC = await callApi(reqC);
  assert.equal(resC.status, 422);

  // Test D: P/L % agreement with 0.05% tolerance (repeating decimal: 1000 on 30000 = 3.333...%, submitted 3.33%)
  const reqD = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "EUR/USD",
      account_size: 30000,
      risk_per_trade: 1.0,
      result_type: "PROFIT",
      profit: 1000,
      loss: 0,
      pl_percentage: 3.33,
      trade_number: 1,
    }),
  });
  const resD = await callApi(reqD);
  assert.equal(resD.status, 200);
  const tradeD = await resD.json();
  assert.equal(tradeD.pl_percentage, 3.33);

  // Test E: P/L % mismatch (> 0.05% difference: 5000 profit on 100000 is 5.0%, submitted 8.0%)
  const reqE = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "GBP/USD",
      account_size: 100000,
      risk_per_trade: 1.0,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 8.0,
      trade_number: 2,
    }),
  });
  const resE = await callApi(reqE);
  assert.equal(resE.status, 400);
  const jsonE = await resE.json();
  assert.match(jsonE.detail, /does not agree/i);

  // Test F: Non-finite values (Infinity or NaN) -> 422
  const reqF = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "XAU/USD",
      account_size: "invalid",
      risk_per_trade: 1.0,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 2,
    }),
  });
  const resF = await callApi(reqF);
  assert.equal(resF.status, 422);

  // Test G: Submission after deadline when stored state is still ACTIVE
  mockDb._store.round3_state[0].phase_ends_at = new Date(Date.now() - 5000).toISOString();
  const reqG = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "BTC/USDT",
      account_size: 100000,
      risk_per_trade: 1.0,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 2,
    }),
  });
  const resG = await callApi(reqG);
  assert.equal(resG.status, 400);
  const jsonG = await resG.json();
  assert.match(jsonG.detail, /closed/i);
});

test("6. Two-slot limit, duplicate retry safety, and slot assignment", async () => {
  const mockDb = createMockSupabase();
  setTestDb(mockDb);
  mockDb._store.round3_state[0].status = "ACTIVE";
  mockDb._store.round3_state[0].phase = "ACTIVE";
  mockDb._store.round3_state[0].phase_ends_at = new Date(Date.now() + 3600000).toISOString();
  mockDb._store.event_config[0].rounds["3"].state = "ACTIVE";
  invalidateConfigCache();

  // 1. Submit Slot 1
  const req1 = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "BTC/USDT",
      account_size: 100000,
      risk_per_trade: 1.5,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 1,
    }),
  });
  const res1 = await callApi(req1);
  assert.equal(res1.status, 200);
  const trade1 = await res1.json();
  assert.equal(trade1.trade_number, 1);
  assert.equal(trade1.verification_status, "PENDING");

  // 2. Retry / double click slot 1 -> must return 409 SLOT_ALREADY_USED and NOT consume slot 2!
  const retryReq = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-teammate" },
    body: JSON.stringify({
      asset: "BTC/USDT",
      account_size: 100000,
      risk_per_trade: 1.5,
      result_type: "PROFIT",
      profit: 5000,
      loss: 0,
      pl_percentage: 5.0,
      trade_number: 1,
    }),
  });
  const retryRes = await callApi(retryReq);
  assert.equal(retryRes.status, 409);

  // Check that slot 2 is still untouched
  const teamTrades = mockDb._store.trades.filter((t) => t.team_id === "team-1");
  assert.equal(teamTrades.length, 1);

  // 3. Submit Slot 2
  const req2 = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "ETH/USDT",
      account_size: 100000,
      risk_per_trade: 1.0,
      result_type: "LOSS",
      profit: 0,
      loss: 2000,
      pl_percentage: -2.0,
      trade_number: 2,
    }),
  });
  const res2 = await callApi(req2);
  assert.equal(res2.status, 200);
  const trade2 = await res2.json();
  assert.equal(trade2.trade_number, 2);

  // 4. Attempt 3rd trade -> Rejected with TRADE_LIMIT
  const req3 = new Request("http://localhost/api/rounds/3/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
    body: JSON.stringify({
      asset: "SOL/USDT",
      account_size: 100000,
      risk_per_trade: 1.0,
      result_type: "PROFIT",
      profit: 1000,
      loss: 0,
      pl_percentage: 1.0,
    }),
  });
  const res3 = await callApi(req3);
  assert.equal(res3.status, 400);
  const res3Json = await res3.json();
  assert.match(res3Json.detail, /limit/i);
});

test("7. Verification lifecycle, scoring contribution, and finalization lock", async () => {
  const mockDb = createMockSupabase();
  setTestDb(mockDb);
  mockDb._store.round3_state[0].status = "ACTIVE";
  mockDb._store.round3_state[0].phase = "ACTIVE";
  mockDb._store.round3_state[0].phase_ends_at = new Date(Date.now() + 3600000).toISOString();
  mockDb._store.event_config[0].rounds["3"].state = "ACTIVE";
  invalidateConfigCache();
  invalidateLeaderboardCache();

  // Team 1 submits Trade 1 (10% profit -> perf: 1000, risk: 1000 -> total: 1000)
  const t1Res = await callApi(
    new Request("http://localhost/api/rounds/3/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
      body: JSON.stringify({
        asset: "BTC/USDT",
        account_size: 100000,
        risk_per_trade: 1.0,
        result_type: "PROFIT",
        profit: 10000,
        loss: 0,
        pl_percentage: 10.0,
        trade_number: 1,
      }),
    })
  );
  const t1 = await t1Res.json();

  // Team 1 submits Trade 2 (2.5% profit -> perf: 500, risk: 1000 -> total: 700)
  const t2Res = await callApi(
    new Request("http://localhost/api/rounds/3/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-alice" },
      body: JSON.stringify({
        asset: "ETH/USDT",
        account_size: 100000,
        risk_per_trade: 1.0,
        result_type: "PROFIT",
        profit: 2500,
        loss: 0,
        pl_percentage: 2.5,
        trade_number: 2,
      }),
    })
  );
  const t2 = await t2Res.json();

  // Both trades are PENDING.
  // In participant status:
  const stRes = await callApi(new Request("http://localhost/api/rounds/3/status", { headers: { Authorization: "Bearer user-alice" } }));
  const stData = await stRes.json();
  assert.equal(stData.has_pending_trades, true);
  // Verified score should be 0 because NEITHER is verified yet!
  assert.equal(stData.r3_score, 0);
  // Provisional score evaluates (1000 + 700) / 2 = 850
  assert.equal(stData.r3_provisional_score, 850);

  // Leaderboard should NOT count pending trades for official R3 score
  const lbScores1 = await computeScores();
  const aliceRow1 = lbScores1.find((r) => r.team_id === "team-1");
  assert.equal(aliceRow1.round3, 0);

  // Admin attempts to finalize while trades are pending -> BLOCKED!
  const finReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ action: "finalize" }),
  });
  const finRes = await callApi(finReq);
  assert.equal(finRes.status, 400);
  const finJson = await finRes.json();
  assert.match(finJson.detail, /pending/i);

  // Admin VERIFIES Trade 1
  const ver1Req = new Request(`http://localhost/api/admin/trades/${t1.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ status: "VERIFIED" }),
  });
  const ver1Res = await callApi(ver1Req);
  assert.equal(ver1Res.status, 200);

  // Admin REJECTS Trade 2 with reason
  const rej2Req = new Request(`http://localhost/api/admin/trades/${t2.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ status: "REJECTED", reason: "Timestamp mismatch on TradingView" }),
  });
  const rej2Res = await callApi(rej2Req);
  assert.equal(rej2Res.status, 200);

  // Now:
  // Trade 1 is VERIFIED (score = 1000).
  // Trade 2 is REJECTED (contributes 0).
  // Weight is NOT redistributed: R3 raw score = (1000 + 0) / 2 = 500!
  invalidateLeaderboardCache();
  const lbScores2 = await computeScores();
  const aliceRow2 = lbScores2.find((r) => r.team_id === "team-1");
  assert.equal(aliceRow2.round3, 500);

  // Participant status confirms:
  const stRes2 = await callApi(new Request("http://localhost/api/rounds/3/status", { headers: { Authorization: "Bearer user-alice" } }));
  const stData2 = await stRes2.json();
  assert.equal(stData2.has_pending_trades, false);
  assert.equal(stData2.r3_score, 500);

  // Finalization now SUCCEEDS because no pending trades remain
  const finRes2 = await callApi(
    new Request("http://localhost/api/admin/event/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
      body: JSON.stringify({ action: "finalize" }),
    })
  );
  assert.equal(finRes2.status, 200);
  assert.equal(mockDb._store.event_config[0].results_finalized, true);

  // After finalization: trade mutations are BLOCKED
  const postFinReq = new Request(`http://localhost/api/admin/trades/${t1.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ status: "REJECTED", reason: "Late objection" }),
  });
  const postFinRes = await callApi(postFinReq);
  assert.equal(postFinRes.status, 400);
});

test("8. Reset gameplay clears Round 3 runtime state consistently", async () => {
  const mockDb = createMockSupabase();
  setTestDb(mockDb);

  const resetReq = new Request("http://localhost/api/admin/event/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-admin" },
    body: JSON.stringify({ action: "reset" }),
  });
  const resetRes = await callApi(resetReq);
  assert.equal(resetRes.status, 200);

  const r3 = mockDb._store.round3_state[0];
  assert.equal(r3.status, "IDLE");
  assert.equal(r3.phase, "WAITING");
  assert.equal(r3.round_duration_minutes, 90);
  assert.equal(r3.is_paused, false);
  assert.equal(mockDb._store.trades.length, 0);
  assert.equal(mockDb._store.event_config[0].rounds["3"].state, "UPCOMING");
});

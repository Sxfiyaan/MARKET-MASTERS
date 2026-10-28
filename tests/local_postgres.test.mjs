import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/**
 * =============================================================================
 * ISOLATED LOCAL POSTGRESQL / SUPABASE ENGINE TESTS
 * =============================================================================
 * Exercises the actual compiled PostgreSQL functions from migration 202610250007
 * inside a local, isolated PostgreSQL 16 Docker container (mm-test-pg).
 * =============================================================================
 */

function runSql(sql, user = "postgres") {
  try {
    const stdout = execFileSync(
      "docker",
      ["exec", "-i", "mm-test-pg", "psql", "-U", user, "-X", "-A", "-t", "-c", sql],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const lastLine = lines.length ? lines[lines.length - 1] : "";
    return { stdout: lastLine, raw: stdout.trim(), error: null };
  } catch (err) {
    return { stdout: null, raw: null, error: err };
  }
}

function ensureSeedData() {
  runSql(`
    insert into auth.users (id, email)
    values ('00000000-0000-0000-0000-000000000099'::uuid, 'owner@test.com')
    on conflict (id) do nothing;

    insert into public.teams (id, team_name, leader_name, leader_email, leader_phone, college, owner_user_id)
    values ('00000000-0000-0000-0000-000000000010'::uuid, 'Alpha Desk', 'Leader', 'leader@test.com', '1234567890', 'Test College', '00000000-0000-0000-0000-000000000099'::uuid)
    on conflict (id) do nothing;

    insert into public.questions (id, round, text, options, correct_answer, base_points, time_limit, question_order)
    values ('00000000-0000-0000-0000-000000000001'::uuid, 1, 'What is ROI?', '["Return on Investment", "Rate of Interest"]'::jsonb, 'A', 100, 30, 1)
    on conflict (id) do nothing;
  `);
}

test("1. Local PostgreSQL: Enforces service_role-only execution privileges", () => {
  ensureSeedData();

  // Attempting to execute submit_round1_answer as anon must fail with permission denied
  const anonRes = runSql(
    "set role anon; select public.submit_round1_answer('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'A');"
  );
  assert.ok(anonRes.error, "anon caller must receive permission denied");
  assert.match(anonRes.error.message, /permission denied for function submit_round1_answer/);

  // Attempting to execute advance_round1_state_tx as authenticated must fail
  const authRes = runSql(
    "set role authenticated; select public.advance_round1_state_tx();"
  );
  assert.ok(authRes.error, "authenticated caller must receive permission denied");
  assert.match(authRes.error.message, /permission denied for function advance_round1_state_tx/);

  // Attempting to execute admin_stop_event_tx as anon must fail
  const stopAnonRes = runSql(
    "set role anon; select public.admin_stop_event_tx();"
  );
  assert.ok(stopAnonRes.error, "anon caller cannot stop event");
  assert.match(stopAnonRes.error.message, /permission denied for function admin_stop_event_tx/);

  // service_role execution must succeed
  const serviceRes = runSql(
    "set role service_role; select public.advance_round1_state_tx();"
  );
  assert.strictEqual(serviceRes.error, null, "service_role must have execution permission");
});

test("2. Local PostgreSQL: admin_reset_gameplay_tx acquires locks and resets state atomically", () => {
  ensureSeedData();

  // Populate submission
  runSql(`
    insert into public.submissions (team_id, question_id, round, answer, correct, time_taken, score)
    values ('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 1, 'A', true, 5.0, 100);
  `);

  const countBefore = runSql("select count(*) from public.submissions;").stdout;
  assert.strictEqual(countBefore, "1");

  // Call admin_reset_gameplay_tx as service_role
  const res = runSql("set role service_role; select public.admin_reset_gameplay_tx();");
  assert.strictEqual(res.error, null);
  const state = JSON.parse(res.stdout);
  assert.strictEqual(state.status, "IDLE");
  assert.strictEqual(state.phase, "WAITING");

  const countAfter = runSql("select count(*) from public.submissions;").stdout;
  assert.strictEqual(countAfter, "0", "All submissions must be purged atomically");

  const eventRounds = runSql("select rounds->'1'->>'state' from public.event_config where id = 'event';").stdout;
  assert.strictEqual(eventRounds, "UPCOMING", "event_config must be reset to UPCOMING");
});

test("3. Local PostgreSQL: admin_start_event_tx blocks starting when R1 is active or played", () => {
  ensureSeedData();

  // 1. When R1 is IDLE and no submissions exist: Start Event succeeds
  const startSuccess = runSql("set role service_role; select public.admin_start_event_tx();");
  assert.strictEqual(startSuccess.error, null);
  const okData = JSON.parse(startSuccess.stdout);
  assert.strictEqual(okData.ok, true);

  // 2. Put R1 into ACTIVE status
  runSql("update public.round1_state set status = 'ACTIVE', phase = 'QUESTION' where id = 'current';");

  // Starting event while R1 is active must fail with R1_ACTIVE
  const startActiveRes = runSql("set role service_role; select public.admin_start_event_tx();");
  assert.strictEqual(startActiveRes.error, null);
  const activeData = JSON.parse(startActiveRes.stdout);
  assert.strictEqual(activeData.ok, false);
  assert.strictEqual(activeData.code, "R1_ACTIVE");

  // Reset to IDLE
  runSql("update public.round1_state set status = 'IDLE', phase = 'WAITING' where id = 'current';");

  // 3. Add existing submission: Starting event without Reset must fail with ROUND_PLAYED
  runSql(`
    insert into public.submissions (team_id, question_id, round, answer, correct, time_taken, score)
    values ('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 1, 'A', true, 5.0, 100);
  `);
  const startPlayedRes = runSql("set role service_role; select public.admin_start_event_tx();");
  const playedData = JSON.parse(startPlayedRes.stdout);
  assert.strictEqual(playedData.ok, false);
  assert.strictEqual(playedData.code, "ROUND_PLAYED");

  // Clean up
  runSql("delete from public.submissions;");
});

test("4. Local PostgreSQL: admin_set_round1_state_tx manages R1 transitions with consistent lock order", () => {
  ensureSeedData();

  const frozenQs = JSON.stringify([
    {
      id: "00000000-0000-0000-0000-000000000001",
      round: 1,
      text: "What is ROI?",
      options: ["Return on Investment", "Rate of Interest"],
      correct_answer: "A",
      base_points: 100,
      time_limit: 30,
      question_order: 1,
    },
  ]);

  // (a) Start Round 1: transitions to COUNTDOWN
  const startRes = runSql(`set role service_role; select public.admin_set_round1_state_tx('ACTIVE', now(), '${frozenQs}'::jsonb, 0.5);`);
  assert.strictEqual(startRes.error, null);
  const startData = JSON.parse(startRes.stdout);
  assert.strictEqual(startData.ok, true);
  assert.strictEqual(startData.state.status, "COUNTDOWN");
  assert.strictEqual(startData.state.phase, "COUNTDOWN");

  // (b) Pause Round 1
  const pauseRes = runSql(`set role service_role; select public.admin_set_round1_state_tx('PAUSED', now());`);
  const pauseData = JSON.parse(pauseRes.stdout);
  assert.strictEqual(pauseData.ok, true);
  assert.strictEqual(pauseData.state.is_paused, true);
  assert.strictEqual(pauseData.state.status, "PAUSED");

  // (c) Resume Round 1
  const resumeRes = runSql(`set role service_role; select public.admin_set_round1_state_tx('ACTIVE', now());`);
  const resumeData = JSON.parse(resumeRes.stdout);
  assert.strictEqual(resumeData.ok, true);
  assert.strictEqual(resumeData.state.is_paused, false);

  // (d) Stop Event
  const stopRes = runSql(`set role service_role; select public.admin_stop_event_tx();`);
  const stopData = JSON.parse(stopRes.stdout);
  assert.strictEqual(stopData.status, "COMPLETED");

  // (e) Subsequent submit is rejected
  const submitRes = runSql(
    `set role service_role; select public.submit_round1_answer('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'A');`
  );
  const submitData = JSON.parse(submitRes.stdout);
  assert.strictEqual(submitData.ok, false);
  assert.strictEqual(submitData.code, "NOT_OPEN");

  // Clean up
  runSql("set role service_role; select public.admin_reset_gameplay_tx();");
});

test("5. Local PostgreSQL: Schema query regression - validates ordering columns against real schema without non-existent id columns", () => {
  ensureSeedData();

  // (a) Proving the regression: score_overrides has NO id column, so ordering by id fails in PostgreSQL
  const badScoreOverrides = runSql("select * from public.score_overrides order by id limit 1;");
  assert.ok(badScoreOverrides.error, "score_overrides has no id column and must fail if ordered by id");
  assert.match(badScoreOverrides.error.message, /column "id" does not exist/);

  // (b) score_overrides must be ordered by composite key (team_id, round)
  const okScoreOverrides = runSql("select * from public.score_overrides order by team_id asc, round asc limit 1;");
  assert.strictEqual(okScoreOverrides.error, null, "Composite key ordering (team_id, round) must succeed");

  // (c) leaderboard_snapshot must be ordered by primary key (team_id)
  const okLeaderboard = runSql("select * from public.leaderboard_snapshot order by team_id asc limit 1;");
  assert.strictEqual(okLeaderboard.error, null, "leaderboard_snapshot primary key order by team_id must succeed");

  // (d) All other tables with primary key 'id'
  const standardTables = [
    "teams",
    "submissions",
    "trades",
    "questions",
    "round3_sessions",
    "announcements",
    "audit_logs",
    "profiles",
  ];
  for (const table of standardTables) {
    const res = runSql(`select * from public.${table} order by id asc limit 1;`);
    assert.strictEqual(res.error, null, `Ordering by id on public.${table} must succeed`);
  }
});

test("6. Local PostgreSQL: admin_set_round1_state_tx advances expired phase before pause (Q1 deadline + 1s)", () => {
  ensureSeedData();
  runSql("set role service_role; select public.admin_reset_gameplay_tx();");

  const q1Id = "00000000-0000-0000-0000-000000000001";
  const frozenQs = JSON.stringify([
    {
      id: q1Id,
      round: 1,
      text: "What is ROI?",
      options: ["Return on Investment", "Rate of Interest"],
      correct_answer: "A",
      base_points: 100,
      time_limit: 30,
      question_order: 1,
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      round: 1,
      text: "What is Beta?",
      options: ["Risk", "Return"],
      correct_answer: "A",
      base_points: 100,
      time_limit: 20,
      question_order: 2,
    },
  ]);

  // Set Round 1 into active QUESTION phase where Q1 deadline expired exactly 1 second ago
  runSql(`
    update public.round1_state
    set status = 'ACTIVE',
        phase = 'QUESTION',
        current_question_index = 0,
        current_question_id = '${q1Id}'::uuid,
        total_questions = 2,
        phase_start_at = now() - interval '31 seconds',
        phase_ends_at = now() - interval '1 second',
        countdown_seconds = 10,
        result_seconds = 10,
        closed_question_ids = array[]::uuid[],
        frozen_questions = '${frozenQs}'::jsonb,
        is_paused = false,
        paused_remaining_ms = 0,
        version = version + 1,
        updated_at = now() - interval '1 second'
    where id = 'current';

    update public.event_config
    set rounds = jsonb_set(coalesce(rounds, '{}'::jsonb), '{1}', jsonb_build_object('state', 'ACTIVE', 'started_at', now() - interval '31 seconds', 'ended_at', null))
    where id = 'event';
  `);

  // Admin hits PAUSE at Q1 deadline + 1 second WITHOUT an intervening status request
  const pauseRes = runSql("set role service_role; select public.admin_set_round1_state_tx('PAUSED', now());");
  assert.strictEqual(pauseRes.error, null);
  const pauseData = JSON.parse(pauseRes.stdout);
  assert.strictEqual(pauseData.ok, true);

  const state = pauseData.state;
  assert.strictEqual(state.is_paused, true);
  // Crucial: Must freeze the RESULT phase, NOT the expired QUESTION phase!
  assert.strictEqual(state.pause_phase, "RESULT", "Pause must freeze the RESULT phase");
  // In the 10-second RESULT phase, 1 second has elapsed, so approximately 9 seconds (9,000 ms) remain
  assert.ok(
    state.paused_remaining_ms >= 8000 && state.paused_remaining_ms <= 10000,
    `paused_remaining_ms (${state.paused_remaining_ms}) must reflect ~9s remaining in RESULT phase`
  );
  // Q1 must be recorded as genuinely closed
  assert.ok(
    state.closed_question_ids.includes(q1Id),
    "Q1 must be recorded in closed_question_ids"
  );

  // Clean up
  runSql("set role service_role; select public.admin_reset_gameplay_tx();");
});

test("7. Local PostgreSQL: admin_stop_event_tx and COMPLETED retain Q1 as closed when deadline passed (Q1 deadline + 1s)", () => {
  ensureSeedData();
  runSql("set role service_role; select public.admin_reset_gameplay_tx();");

  const q1Id = "00000000-0000-0000-0000-000000000001";
  const frozenQs = JSON.stringify([
    {
      id: q1Id,
      round: 1,
      text: "What is ROI?",
      options: ["Return on Investment", "Rate of Interest"],
      correct_answer: "A",
      base_points: 100,
      time_limit: 30,
      question_order: 1,
    },
  ]);

  // Desk submitted an answer during Q1
  runSql(`
    insert into public.submissions (team_id, question_id, round, answer, correct, time_taken, score)
    values ('00000000-0000-0000-0000-000000000010'::uuid, '${q1Id}'::uuid, 1, 'A', true, 5.0, 100);
  `);

  // Set Round 1 into active QUESTION phase where Q1 deadline expired exactly 1 second ago
  runSql(`
    update public.round1_state
    set status = 'ACTIVE',
        phase = 'QUESTION',
        current_question_index = 0,
        current_question_id = '${q1Id}'::uuid,
        total_questions = 1,
        phase_start_at = now() - interval '31 seconds',
        phase_ends_at = now() - interval '1 second',
        countdown_seconds = 10,
        result_seconds = 10,
        closed_question_ids = array[]::uuid[],
        frozen_questions = '${frozenQs}'::jsonb,
        is_paused = false,
        paused_remaining_ms = 0,
        version = version + 1,
        updated_at = now() - interval '1 second'
    where id = 'current';

    update public.event_config
    set rounds = jsonb_set(coalesce(rounds, '{}'::jsonb), '{1}', jsonb_build_object('state', 'ACTIVE', 'started_at', now() - interval '31 seconds', 'ended_at', null))
    where id = 'event';
  `);

  // Admin hits STOP EVENT at Q1 deadline + 1 second WITHOUT an intervening status request
  const stopRes = runSql("set role service_role; select public.admin_stop_event_tx(now());");
  assert.strictEqual(stopRes.error, null);
  const stopData = JSON.parse(stopRes.stdout);

  assert.strictEqual(stopData.status, "COMPLETED");
  assert.strictEqual(stopData.phase, "COMPLETED");
  // Crucial: Q1 deadline passed, so Q1 must be preserved in closed_question_ids and its points counted!
  assert.ok(
    stopData.closed_question_ids.includes(q1Id),
    "Stop event must retain Q1 as closed and preserve earned points when deadline already passed"
  );

  // Contrast test: If Q1 deadline has NOT passed yet (e.g. 10s remaining), stop must NOT close Q1 prematurely
  runSql(`
    update public.round1_state
    set status = 'ACTIVE',
        phase = 'QUESTION',
        current_question_index = 0,
        current_question_id = '${q1Id}'::uuid,
        phase_start_at = now() - interval '10 seconds',
        phase_ends_at = now() + interval '20 seconds',
        closed_question_ids = array[]::uuid[],
        version = version + 1
    where id = 'current';
  `);

  const stopEarlyRes = runSql("set role service_role; select public.admin_stop_event_tx(now());");
  const stopEarlyData = JSON.parse(stopEarlyRes.stdout);
  assert.ok(
    !stopEarlyData.closed_question_ids.includes(q1Id),
    "Stop event must NEVER close a question prematurely when deadline has not passed"
  );

  // Clean up
  runSql("set role service_role; select public.admin_reset_gameplay_tx();");
});

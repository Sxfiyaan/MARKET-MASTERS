import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const CONTAINER = "supabase_db_market-masters-supabase";
const TEST_DB = "pg_concurrency_test";

function execSql(sql, db = TEST_DB) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-X",
      "-A",
      "-t",
      "-c",
      sql,
    ]);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data));
    proc.stderr.on("data", (data) => (stderr += data));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`psql error (exit ${code}): ${stderr || stdout}`));
      } else {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(lines.length ? lines[lines.length - 1] : "");
      }
    });
  });
}

function runInteractiveSql(commands, db = TEST_DB) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-X",
      "-A",
      "-t",
    ]);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data));
    proc.stderr.on("data", (data) => (stderr += data));

    proc.stdin.write(commands);
    proc.stdin.end();

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Interactive psql error (${code}): ${stderr || stdout}`));
      } else {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(lines);
      }
    });
  });
}

test("Setup isolated PostgreSQL database for concurrent connection tests", async () => {
  await execSql(`DROP DATABASE IF EXISTS ${TEST_DB};`, "postgres");
  await execSql(`CREATE DATABASE ${TEST_DB};`, "postgres");

  // Initial auth and roles
  await execSql(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid primary key, email text);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
    END $$;
  `);

  // Apply migrations 0001 through 0008
  const fs = await import("node:fs");
  const path = await import("node:path");
  const migDir = path.resolve("supabase/migrations");
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), "utf8");
    await new Promise((resolve, reject) => {
      const proc = spawn("docker", [
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        TEST_DB,
        "-v",
        "ON_ERROR_STOP=1",
      ]);
      proc.stdin.write(sql);
      proc.stdin.end();
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Migration ${file} failed`))));
    });
  }

  // Seed test team and question
  await execSql(`
    INSERT INTO public.event_config (id, event_name, registration_open, leaderboard_visible)
    VALUES ('event', 'Market Masters Concurrency', true, true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.round1_state (id) VALUES ('current') ON CONFLICT (id) DO NOTHING;

    INSERT INTO auth.users (id, email)
    VALUES
      ('00000000-0000-0000-0000-000000000099'::uuid, 'leader@test.com'),
      ('00000000-0000-0000-0000-000000000098'::uuid, 'leader2@test.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.teams (id, team_name, leader_name, leader_email, leader_phone, college, owner_user_id)
    VALUES
      ('00000000-0000-0000-0000-000000000010'::uuid, 'Alpha Desk', 'Leader', 'leader@test.com', '1234567890', 'College', '00000000-0000-0000-0000-000000000099'::uuid),
      ('00000000-0000-0000-0000-000000000020'::uuid, 'Beta Desk', 'Leader 2', 'leader2@test.com', '1234567891', 'College', '00000000-0000-0000-0000-000000000098'::uuid)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.questions (id, round, text, options, correct_answer, base_points, time_limit, question_order)
    VALUES ('00000000-0000-0000-0000-000000000002'::uuid, 2, 'What is Beta?', '["Risk", "Return"]'::jsonb, 'A', 100, 30, 1)
    ON CONFLICT (id) DO NOTHING;
  `);
});

test("Concurrency 1: Connection 2 score override blocked by in-flight finalization, unblocks and rejects after commit", async () => {
  // Set rounds completed and results_finalized = false
  await execSql(`
    UPDATE public.event_config
    SET rounds = '{"1":{"state":"COMPLETED"},"2":{"state":"COMPLETED"},"3":{"state":"COMPLETED"}}'::jsonb,
        results_finalized = false
    WHERE id = 'event';
    UPDATE public.round1_state SET status = 'COMPLETED', phase = 'COMPLETED', is_paused = false WHERE id = 'current';
    DELETE FROM public.score_overrides;
  `);

  // Connection 1: Starts a transaction, acquires finalization row lock, sleeps 400ms, finalizes, and commits
  const conn1Promise = runInteractiveSql(`
    BEGIN;
    SELECT * FROM public.round1_state WHERE id = 'current' FOR UPDATE;
    SELECT * FROM public.event_config WHERE id = 'event' FOR UPDATE;
    SELECT pg_sleep(0.4);
    SELECT public.admin_finalize_results_tx();
    COMMIT;
  `);

  // Connection 2: Starts 100ms later while Connection 1 holds the lock
  await new Promise((r) => setTimeout(r, 100));

  const conn2Start = Date.now();
  const conn2Res = await execSql(`
    SET role service_role;
    SELECT public.admin_set_score_override_tx('00000000-0000-0000-0000-000000000010'::uuid, 1, 999, 'Late override concurrent');
  `);
  const conn2Duration = Date.now() - conn2Start;

  // Wait for Connection 1 to finish
  await conn1Promise;

  // Assertions:
  // 1. Connection 2 must have waited on Connection 1's lock (duration > 200ms)
  assert.ok(conn2Duration >= 200, `Connection 2 must wait on lock; duration was ${conn2Duration}ms`);

  // 2. Connection 2 must have received FINALIZED error code!
  const conn2Data = JSON.parse(conn2Res);
  assert.strictEqual(conn2Data.ok, false, "Concurrent override during finalization must fail");
  assert.strictEqual(conn2Data.code, "FINALIZED", "Must reject with FINALIZED code");

  // 3. Verify database state: results_finalized is TRUE, score_overrides has ZERO rows
  const finalized = await execSql(`SELECT results_finalized FROM public.event_config WHERE id = 'event';`);
  assert.strictEqual(finalized, "t", "results_finalized must be true");

  const overrideCount = await execSql(`SELECT count(*) FROM public.score_overrides WHERE team_id = '00000000-0000-0000-0000-000000000010'::uuid;`);
  assert.strictEqual(overrideCount, "0", "Zero score overrides must be written post-finalization");
});

test("Concurrency 2: Earlier write finishes before finalization, later write rejects; scores never change post-finalization", async () => {
  // Reopen results
  await execSql(`
    SET role service_role;
    SELECT public.admin_reopen_results_tx();
  `);

  // 1. Earlier write: writes score 750 before finalization
  const earlyRes = await execSql(`
    SET role service_role;
    SELECT public.admin_set_score_override_tx('00000000-0000-0000-0000-000000000010'::uuid, 1, 750, 'Early valid write');
  `);
  const earlyData = JSON.parse(earlyRes);
  assert.strictEqual(earlyData.ok, true, "Earlier write before finalization must succeed");

  // Verify score in DB is 750
  const scoreBefore = await execSql(`
    SELECT new_score FROM public.score_overrides WHERE team_id = '00000000-0000-0000-0000-000000000010'::uuid AND round = 1;
  `);
  assert.strictEqual(scoreBefore, "750");

  // 2. Finalization runs and commits
  const finalizeRes = await execSql(`
    SET role service_role;
    SELECT public.admin_finalize_results_tx();
  `);
  const finalizeData = JSON.parse(finalizeRes);
  assert.strictEqual(finalizeData.ok, true, "Finalization must succeed");

  // 3. Later write attempts score 999: MUST REJECT
  const lateRes = await execSql(`
    SET role service_role;
    SELECT public.admin_set_score_override_tx('00000000-0000-0000-0000-000000000010'::uuid, 1, 999, 'Late write attempt');
  `);
  const lateData = JSON.parse(lateRes);
  assert.strictEqual(lateData.ok, false, "Later write after finalization must be rejected");
  assert.strictEqual(lateData.code, "FINALIZED");

  // 4. Verify score in DB is STILL 750 (never changed post-finalization!)
  const scoreAfter = await execSql(`
    SELECT new_score FROM public.score_overrides WHERE team_id = '00000000-0000-0000-0000-000000000010'::uuid AND round = 1;
  `);
  assert.strictEqual(scoreAfter, "750", "Score must remain 750 and never change after finalization");
});

test("Concurrency 3: Concurrent Round 2 submission during/after finalization is rejected", async () => {
  // Results are currently finalized (from previous test)
  const r2Res = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Technical breakout test explanation'
    );
  `);
  const r2Data = JSON.parse(r2Res);
  assert.strictEqual(r2Data.ok, false);
  assert.strictEqual(r2Data.code, "FINALIZED", "Round 2 submission must be rejected when finalized");

  // Verify zero R2 submissions exist
  const subCount = await execSql(`SELECT count(*) FROM public.submissions WHERE round = 2;`);
  assert.strictEqual(subCount, "0", "No R2 submissions may be inserted post-finalization");
});

test("Concurrency 4: Simultaneous submissions from DIFFERENT teams execute concurrently without serialization", async () => {
  // Reopen results and set Round 2 to ACTIVE, phase to QUESTION
  await execSql(`
    SELECT public.admin_reopen_results_tx();
    UPDATE public.round2_state
    SET status = 'ACTIVE',
        phase = 'QUESTION',
        current_question_index = 0,
        current_question_id = '00000000-0000-0000-0000-000000000002'::uuid,
        phase_start_at = clock_timestamp(),
        phase_ends_at = clock_timestamp() + interval '120 seconds',
        is_paused = false,
        paused_remaining_ms = 0
    WHERE id = 'current';
    UPDATE public.event_config
    SET rounds = jsonb_set(coalesce(rounds, '{}'::jsonb), '{2}', '{"state":"ACTIVE"}'::jsonb)
    WHERE id = 'event';
    DELETE FROM public.submissions WHERE round = 2;
  `);

  // Connection 1: Team Alpha starts transaction, runs submit_round2_answer_tx (acquires shared locks),
  // sleeps 400ms inside the transaction, and commits
  const conn1Promise = runInteractiveSql(`
    BEGIN;
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Team Alpha explanation: Bullish momentum breakout.'
    );
    SELECT pg_sleep(0.4);
    COMMIT;
  `);

  // Connection 2: Team Beta submits 100ms later while Connection 1 is still sleeping with shared locks
  await new Promise((r) => setTimeout(r, 100));

  const conn2Start = Date.now();
  const conn2Res = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000020'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'SELL',
      'Team Beta explanation: Bearish divergence.'
    );
  `);
  const conn2Duration = Date.now() - conn2Start;

  const conn1Lines = await conn1Promise;
  const conn1Data = JSON.parse(conn1Lines[conn1Lines.length - 2]); // Output before COMMIT
  const conn2Data = JSON.parse(conn2Res);

  // Assertions:
  // 1. Connection 2 must NOT be serialized on Connection 1's lock (duration < 250ms, does not wait for 400ms sleep)
  assert.ok(
    conn2Duration < 250,
    `Connection 2 must execute concurrently without waiting on Connection 1; duration was ${conn2Duration}ms`
  );

  // 2. Both submissions succeed
  assert.strictEqual(conn1Data.ok, true, "Team Alpha submission must succeed");
  assert.strictEqual(conn1Data.answer, "BUY");
  assert.strictEqual(conn2Data.ok, true, "Team Beta submission must succeed");
  assert.strictEqual(conn2Data.answer, "SELL");

  // 3. Both submissions exist in database
  const count = await execSql(`SELECT count(*) FROM public.submissions WHERE round = 2;`);
  assert.strictEqual(count, "2", "Both teams' submissions must be persisted");
});

test("Concurrency 5: Simultaneous duplicate teammate submissions cleanly return ALREADY_SUBMITTED", async () => {
  // Clear R2 submissions and reset question
  await execSql(`
    DELETE FROM public.submissions WHERE round = 2;
  `);

  // Connection 1: Teammate 1 starts transaction, submits for Team Alpha, sleeps 400ms, and commits
  const conn1Promise = runInteractiveSql(`
    BEGIN;
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Teammate 1: Bullish momentum breakout.'
    );
    SELECT pg_sleep(0.4);
    COMMIT;
  `);

  // Connection 2: Teammate 2 attempts submission 100ms later for SAME Team Alpha
  await new Promise((r) => setTimeout(r, 100));

  const conn2Res = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'SELL',
      'Teammate 2: Conflicting trade attempt.'
    );
  `);

  const conn1Lines = await conn1Promise;
  const conn1Data = JSON.parse(conn1Lines[conn1Lines.length - 2]);
  const conn2Data = JSON.parse(conn2Res);

  // Assertions:
  // 1. Teammate 1 succeeded
  assert.strictEqual(conn1Data.ok, true, "First teammate submission must succeed");
  assert.strictEqual(conn1Data.answer, "BUY");

  // 2. Teammate 2 returns ALREADY_SUBMITTED cleanly (not a 500 error!)
  assert.strictEqual(conn2Data.ok, false, "Second teammate submission must be rejected");
  assert.strictEqual(conn2Data.code, "ALREADY_SUBMITTED", "Must return ALREADY_SUBMITTED code");

  // 3. Exactly ONE submission persisted for Team Alpha
  const subCount = await execSql(`
    SELECT count(*) FROM public.submissions
    WHERE team_id = '00000000-0000-0000-0000-000000000010'::uuid AND round = 2;
  `);
  assert.strictEqual(subCount, "1", "Only exactly one submission may be persisted per team");
});

test("Concurrency 6: Strict fail-closed validation in submit_round2_answer_tx", async () => {
  // Clear submissions
  await execSql(`DELETE FROM public.submissions WHERE round = 2;`);

  // Case A: Null active-question ID or mismatch
  const mismatchRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      NULL,
      'BUY',
      'Valid explanation for null question'
    );
  `);
  const mismatchData = JSON.parse(mismatchRes);
  assert.strictEqual(mismatchData.ok, false);
  assert.strictEqual(mismatchData.code, "QUESTION_MISMATCH", "Null question ID must be rejected");

  const diffQRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000099'::uuid,
      'BUY',
      'Valid explanation for wrong question'
    );
  `);
  const diffQData = JSON.parse(diffQRes);
  assert.strictEqual(diffQData.ok, false);
  assert.strictEqual(diffQData.code, "QUESTION_MISMATCH", "Mismatched question ID must be rejected");

  // Case B: phase_start_at is NULL -> INVALID_TIMING
  await execSql(`UPDATE public.round2_state SET phase_start_at = NULL WHERE id = 'current';`);
  const nullStartRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Valid explanation'
    );
  `);
  const nullStartData = JSON.parse(nullStartRes);
  assert.strictEqual(nullStartData.ok, false);
  assert.strictEqual(nullStartData.code, "INVALID_TIMING", "NULL phase_start_at must fail-closed");

  // Case C: phase_ends_at is NULL -> INVALID_TIMING
  await execSql(`UPDATE public.round2_state SET phase_start_at = clock_timestamp(), phase_ends_at = NULL WHERE id = 'current';`);
  const nullEndRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Valid explanation'
    );
  `);
  const nullEndData = JSON.parse(nullEndRes);
  assert.strictEqual(nullEndData.ok, false);
  assert.strictEqual(nullEndData.code, "INVALID_TIMING", "NULL phase_ends_at must fail-closed");

  // Case D: phase_start_at >= phase_ends_at -> INVALID_TIMING
  await execSql(`
    UPDATE public.round2_state
    SET phase_start_at = clock_timestamp() + interval '10 seconds',
        phase_ends_at = clock_timestamp()
    WHERE id = 'current';
  `);
  const invertedRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Valid explanation'
    );
  `);
  const invertedData = JSON.parse(invertedRes);
  assert.strictEqual(invertedData.ok, false);
  assert.strictEqual(invertedData.code, "INVALID_TIMING", "Inverted timing window must fail-closed");

  // Case E: Future start -> NOT_OPEN_YET
  await execSql(`
    UPDATE public.round2_state
    SET phase_start_at = clock_timestamp() + interval '30 seconds',
        phase_ends_at = clock_timestamp() + interval '150 seconds'
    WHERE id = 'current';
  `);
  const futureRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Valid explanation'
    );
  `);
  const futureData = JSON.parse(futureRes);
  assert.strictEqual(futureData.ok, false);
  assert.strictEqual(futureData.code, "NOT_OPEN_YET", "Submissions before phase_start_at must be rejected");

  // Case F: Past deadline -> DEADLINE_EXPIRED
  await execSql(`
    UPDATE public.round2_state
    SET phase_start_at = clock_timestamp() - interval '150 seconds',
        phase_ends_at = clock_timestamp() - interval '30 seconds'
    WHERE id = 'current';
  `);
  const expiredRes = await execSql(`
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Valid explanation'
    );
  `);
  const expiredData = JSON.parse(expiredRes);
  assert.strictEqual(expiredData.ok, false);
  assert.strictEqual(expiredData.code, "DEADLINE_EXPIRED", "Submissions after phase_ends_at must be rejected");

  // Verify zero submissions were inserted
  const subCount = await execSql(`SELECT count(*) FROM public.submissions WHERE round = 2;`);
  assert.strictEqual(subCount, "0", "No submissions must be accepted under invalid states");
});

test("Concurrency 7: admin_set_round2_state_tx rejects UPCOMING across independent PostgreSQL connections and keeps state consistent", async () => {
  // Re-open timing and insert a submission for Alpha Desk
  await execSql(`
    UPDATE public.round2_state
    SET phase_start_at = clock_timestamp() - interval '10 seconds',
        phase_ends_at = clock_timestamp() + interval '110 seconds'
    WHERE id = 'current';
    SET role service_role;
    SELECT public.submit_round2_answer_tx(
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'BUY',
      'Active run submission'
    );
  `);

  // Attempt transition ACTIVE -> UPCOMING
  const upcomingRes = await execSql(`
    SET role service_role;
    SELECT public.admin_set_round2_state_tx('UPCOMING');
  `);
  const upcomingData = JSON.parse(upcomingRes);
  assert.strictEqual(upcomingData.ok, false, "UPCOMING must be rejected when round has submissions");
  assert.strictEqual(upcomingData.code, "ROUND_PLAYED");
  assert.match(upcomingData.error, /Reset Gameplay/);

  // Verify event_config and round2_state remain consistent (both ACTIVE)
  const r2ConfigState = await execSql(`SELECT rounds->'2'->>'state' FROM public.event_config WHERE id = 'event';`);
  const r2TableState = await execSql(`SELECT status FROM public.round2_state WHERE id = 'current';`);
  assert.strictEqual(r2ConfigState, "ACTIVE", "event_config must remain ACTIVE");
  assert.strictEqual(r2TableState, "ACTIVE", "round2_state must remain ACTIVE");

  // Now perform explicit Reset Gameplay: returns to WAITING and clears submissions
  await execSql(`
    SET role service_role;
    SELECT public.admin_reset_gameplay_tx();
  `);

  const resetConfigState = await execSql(`SELECT rounds->'2'->>'state' FROM public.event_config WHERE id = 'event';`);
  const resetTableState = await execSql(`SELECT status FROM public.round2_state WHERE id = 'current';`);
  assert.strictEqual(resetConfigState, "UPCOMING", "event_config must be UPCOMING after reset");
  assert.strictEqual(resetTableState, "IDLE", "round2_state must be IDLE after reset");

  const cleanSubCount = await execSql(`SELECT count(*) FROM public.submissions WHERE round = 2;`);
  assert.strictEqual(cleanSubCount, "0", "All R2 submissions must be cleared by reset");
});

test("Cleanup isolated test database", async () => {
  await execSql(`DROP DATABASE IF EXISTS ${TEST_DB};`, "postgres");
});

-- Migration 0008: Add event_config.results_finalized and transactional finalization lifecycle
-- Safely add results_finalized with DEFAULT false and NOT NULL
alter table public.event_config
  add column if not exists results_finalized boolean not null default false;

-- Atomic Start Event: resets results_finalized = false inside transaction
create or replace function public.admin_start_event_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_rounds jsonb;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_state.id is not null and (v_state.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_state.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot start event while Round 1 is active or paused. Stop or reset the event first.', 'code', 'R1_ACTIVE');
  end if;

  if exists (select 1 from public.submissions where round = 1 limit 1) then
    return jsonb_build_object('ok', false, 'error', 'Cannot start event when a played round exists. Reset gameplay first.', 'code', 'ROUND_PLAYED');
  end if;

  v_rounds := coalesce(v_cfg.rounds, '{}'::jsonb);
  v_rounds := jsonb_set(v_rounds, '{1}', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null));
  v_rounds := jsonb_set(v_rounds, '{2}', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null));
  v_rounds := jsonb_set(v_rounds, '{3}', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null));

  update public.event_config
  set registration_open = true,
      leaderboard_visible = true,
      rounds = v_rounds,
      results_finalized = false
  where id = 'event';

  return jsonb_build_object('ok', true);
end;
$$;

-- Atomic Reset Gameplay: resets results_finalized = false inside transaction
create or replace function public.admin_reset_gameplay_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_rounds jsonb;
  v_q_count integer := 0;
begin
  -- Acquire locks FIRST before deleting records (consistent lock order: round1_state then event_config)
  select * into v_state from public.round1_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  -- Delete all participant submissions, trades, sessions, overrides
  delete from public.submissions where team_id is not null;
  delete from public.trades where team_id is not null;
  delete from public.round3_sessions where team_id is not null;
  delete from public.score_overrides where team_id is not null;
  delete from public.leaderboard_snapshot where team_id is not null;

  -- Determine actual configured question count for Round 1
  select count(*) into v_q_count from public.questions where round = 1;

  v_rounds := jsonb_build_object(
    '1', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null),
    '2', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null),
    '3', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null)
  );

  update public.event_config
  set rounds = v_rounds,
      results_finalized = false
  where id = 'event';

  update public.round1_state
  set status = 'IDLE',
      phase = 'WAITING',
      current_question_index = 0,
      current_question_id = null,
      total_questions = coalesce(v_q_count, 0),
      phase_start_at = null,
      phase_ends_at = null,
      is_paused = false,
      paused_at = null,
      pause_phase = null,
      paused_remaining_ms = 0,
      closed_question_ids = array[]::uuid[],
      frozen_questions = null,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_state;

  return to_jsonb(v_state);
end;
$$;

-- Transactional Finalization: consistent lock order (round1_state then event_config)
-- Requires all rounds to be closed and no pending trade verifications
create or replace function public.admin_finalize_results_tx()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_pending integer := 0;
begin
  -- Consistent lock order across all procedures: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config record not found', 'code', 'CONFIG_MISSING');
  end if;

  -- 1. Require all rounds to be closed (COMPLETED)
  if coalesce(v_cfg.rounds->'1'->>'state', '') <> 'COMPLETED'
     or coalesce(v_cfg.rounds->'2'->>'state', '') <> 'COMPLETED'
     or coalesce(v_cfg.rounds->'3'->>'state', '') <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: all rounds must be completed first', 'code', 'ROUNDS_NOT_COMPLETED');
  end if;

  -- Verify Round 1 state is not active, in countdown, or paused
  if v_state.id is not null and (v_state.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_state.is_paused or v_state.phase <> 'COMPLETED') then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: Round 1 is still in progress', 'code', 'R1_ACTIVE');
  end if;

  -- 2. Require no pending trade verifications
  select count(*) into v_pending from public.trades where verification_status = 'PENDING';
  if v_pending > 0 then
    return jsonb_build_object(
      'ok', false,
      'error', format('Cannot finalize results: %s trade verification(s) are pending review', v_pending),
      'code', 'PENDING_TRADES'
    );
  end if;

  -- 3. Authoritatively mark results as finalized
  update public.event_config
  set results_finalized = true
  where id = 'event';

  return jsonb_build_object('ok', true, 'results_finalized', true);
end;
$$;

-- Transactional Reopen Results: explicit admin action clears finalization
create or replace function public.admin_reopen_results_tx()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config record not found', 'code', 'CONFIG_MISSING');
  end if;

  update public.event_config
  set results_finalized = false
  where id = 'event';

  return jsonb_build_object('ok', true, 'results_finalized', false);
end;
$$;

-- Update submit_round1_answer to reject submissions when results are finalized
create or replace function public.submit_round1_answer(
  p_team_id uuid,
  p_question_id uuid,
  p_answer text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_event record;
  v_question record;
  v_now timestamptz := clock_timestamp();
  v_time_taken numeric;
  v_speed_factor numeric;
  v_correct boolean;
  v_score numeric;
  v_submission_id uuid;
  v_speed_bonus numeric := 0.5;
  v_remaining_seconds numeric;
  v_limit numeric;
  v_base_points numeric;
  v_correct_answer text;
  v_fq jsonb;
  v_item jsonb;
begin
  -- 1. Read current round1_state with share lock
  select * into v_state
  from public.round1_state
  where id = 'current'
  for share;

  if v_state.id is null or v_state.is_paused or v_state.status <> 'ACTIVE' or v_state.phase <> 'QUESTION' then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently open', 'code', 'NOT_OPEN');
  end if;

  -- Verify event_config round 1 is active (Stop Event immediately rejects submissions)
  select * into v_event from public.event_config where id = 'event' for share;
  if v_event.id is not null and (v_event.rounds->'1'->>'state') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 1 is not active', 'code', 'NOT_OPEN');
  end if;

  -- Rejection check: results finalized
  if v_event.id is not null and coalesce(v_event.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if v_state.current_question_id is distinct from p_question_id then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently active', 'code', 'NOT_ACTIVE');
  end if;

  -- 2. Reject missing/invalid question timestamps and enforce start <= server_now < end
  if v_state.phase_start_at is null or v_state.phase_ends_at is null or v_state.phase_start_at >= v_state.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Question timing is invalid or missing deadline', 'code', 'INVALID_TIMING');
  end if;

  if v_now < v_state.phase_start_at then
    return jsonb_build_object('ok', false, 'error', 'Question has not opened yet', 'code', 'NOT_OPEN_YET');
  end if;

  if v_now >= v_state.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Question deadline has expired', 'code', 'DEADLINE_EXPIRED');
  end if;

  -- 3. Verify question metadata from frozen snapshot (or fallback to questions table)
  if v_state.frozen_questions is not null then
    for v_item in select * from jsonb_array_elements(v_state.frozen_questions)
    loop
      if (v_item->>'id')::uuid = p_question_id then
        v_fq := v_item;
        exit;
      end if;
    end loop;
  end if;

  if v_fq is not null then
    v_correct_answer := v_fq->>'correct_answer';
    v_base_points := coalesce((v_fq->>'base_points')::numeric, 100);
    v_limit := coalesce((v_fq->>'time_limit')::numeric, 30);
  else
    select * into v_question
    from public.questions
    where id = p_question_id and round = 1;

    if v_question.id is null then
      return jsonb_build_object('ok', false, 'error', 'Question not found', 'code', 'NOT_FOUND');
    end if;

    v_correct_answer := v_question.correct_answer;
    v_base_points := coalesce(v_question.base_points, 100);
    v_limit := coalesce(v_question.time_limit, 30);
  end if;

  -- 4. Calculate timing and score strictly from server clock against phase_start_at
  v_time_taken := round(extract(epoch from (v_now - v_state.phase_start_at))::numeric, 2);
  if v_time_taken < 0 then
    v_time_taken := 0;
  end if;

  v_remaining_seconds := extract(epoch from (v_state.phase_ends_at - v_now))::numeric;
  if v_limit > 0 then
    v_speed_factor := greatest(0::numeric, round((v_remaining_seconds / v_limit)::numeric, 4));
  else
    v_speed_factor := 0;
  end if;

  v_correct := (upper(trim(p_answer)) = upper(trim(v_correct_answer)));
  v_speed_bonus := coalesce(v_state.speed_bonus_pct, 0.5);

  if v_correct then
    v_score := round(v_base_points * (1::numeric + (v_speed_bonus * v_speed_factor)), 2);
  else
    v_score := 0;
  end if;

  -- 5. Insert submission record (atomic duplicate rejection via unique index)
  begin
    insert into public.submissions (
      team_id,
      question_id,
      round,
      answer,
      correct,
      time_taken,
      score,
      submitted_at
    ) values (
      p_team_id,
      p_question_id,
      1,
      upper(trim(p_answer)),
      v_correct,
      v_time_taken,
      v_score,
      v_now
    ) returning id into v_submission_id;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'Already submitted', 'code', 'ALREADY_SUBMITTED');
  end;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_submission_id,
    'correct', v_correct,
    'score', v_score,
    'time_taken', v_time_taken
  );
end;
$$;

-- Permissions
revoke all on function public.admin_start_event_tx(timestamptz) from public;
revoke all on function public.admin_start_event_tx(timestamptz) from anon;
revoke all on function public.admin_start_event_tx(timestamptz) from authenticated;
grant execute on function public.admin_start_event_tx(timestamptz) to service_role;

revoke all on function public.admin_reset_gameplay_tx(timestamptz) from public;
revoke all on function public.admin_reset_gameplay_tx(timestamptz) from anon;
revoke all on function public.admin_reset_gameplay_tx(timestamptz) from authenticated;
grant execute on function public.admin_reset_gameplay_tx(timestamptz) to service_role;

revoke all on function public.admin_finalize_results_tx() from public;
revoke all on function public.admin_finalize_results_tx() from anon;
revoke all on function public.admin_finalize_results_tx() from authenticated;
grant execute on function public.admin_finalize_results_tx() to service_role;

revoke all on function public.admin_reopen_results_tx() from public;
revoke all on function public.admin_reopen_results_tx() from anon;
revoke all on function public.admin_reopen_results_tx() from authenticated;
grant execute on function public.admin_reopen_results_tx() to service_role;

-- Score-changing writes coordinated at database write boundary
-- Lock order: round1_state then event_config

-- 1. Score override transaction
create or replace function public.admin_set_score_override_tx(
  p_team_id uuid,
  p_round integer,
  p_new_score numeric,
  p_reason text,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before modifying scores.', 'code', 'FINALIZED');
  end if;

  insert into public.score_overrides (team_id, round, new_score, reason, updated_at)
  values (p_team_id, p_round, p_new_score, p_reason, p_now)
  on conflict (team_id, round)
  do update set
    new_score = excluded.new_score,
    reason = excluded.reason,
    updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true);
end;
$$;

-- 2. Trade verification transaction
create or replace function public.admin_verify_trade_tx(
  p_trade_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_trade record;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before modifying trades.', 'code', 'FINALIZED');
  end if;

  update public.trades
  set verification_status = p_status,
      admin_notes = p_reason
  where id = p_trade_id
  returning * into v_trade;

  if v_trade.id is null then
    return jsonb_build_object('ok', false, 'error', 'Trade not found', 'code', 'NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'trade', to_jsonb(v_trade));
end;
$$;

-- 3. Trade deletion transaction
create or replace function public.admin_delete_trade_tx(
  p_trade_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_trade record;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before deleting trades.', 'code', 'FINALIZED');
  end if;

  select * into v_trade from public.trades where id = p_trade_id;
  if v_trade.id is null then
    return jsonb_build_object('ok', false, 'error', 'Trade not found', 'code', 'NOT_FOUND');
  end if;

  delete from public.trades where id = p_trade_id;

  return jsonb_build_object('ok', true, 'trade_id', p_trade_id, 'team_id', v_trade.team_id);
end;
$$;

-- 4. Team deletion transaction
create or replace function public.admin_delete_team_tx(
  p_team_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_team record;
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before deleting teams.', 'code', 'FINALIZED');
  end if;

  select * into v_team from public.teams where id = p_team_id;
  if v_team.id is null then
    return jsonb_build_object('ok', false, 'error', 'Team not found', 'code', 'NOT_FOUND');
  end if;

  delete from public.submissions where team_id = p_team_id;
  delete from public.trades where team_id = p_team_id;
  delete from public.round3_sessions where team_id = p_team_id;
  delete from public.score_overrides where team_id = p_team_id;
  delete from public.leaderboard_snapshot where team_id = p_team_id;
  delete from public.teams where id = p_team_id;

  return jsonb_build_object('ok', true, 'owner_user_id', v_team.owner_user_id, 'team_name', v_team.team_name);
end;
$$;

-- 5. Round 2 submission transaction
create or replace function public.submit_round2_answer_tx(
  p_team_id uuid,
  p_question_id uuid,
  p_answer text,
  p_time_taken numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_question record;
  v_speed_factor numeric;
  v_correct boolean;
  v_score numeric;
  v_submission_id uuid;
  v_speed_bonus numeric;
  v_limit numeric;
  v_base_points numeric;
  v_now timestamptz := clock_timestamp();
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if coalesce(v_cfg.rounds->'2'->>'state', '') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 2 is not active', 'code', 'NOT_ACTIVE');
  end if;

  select * into v_question from public.questions where id = p_question_id and round = 2;
  if v_question.id is null then
    return jsonb_build_object('ok', false, 'error', 'Question not found', 'code', 'NOT_FOUND');
  end if;

  v_limit := coalesce(v_question.time_limit, 30);
  v_base_points := coalesce(v_question.base_points, 100);
  v_speed_bonus := coalesce(v_cfg.speed_bonus_pct, 0.5);

  if v_limit > 0 then
    v_speed_factor := greatest(0::numeric, round((1::numeric - (p_time_taken / v_limit))::numeric, 4));
  else
    v_speed_factor := 0;
  end if;

  v_correct := (upper(trim(p_answer)) = upper(trim(v_question.correct_answer)));
  if v_correct then
    v_score := round(v_base_points * (1::numeric + (v_speed_bonus * v_speed_factor)), 0);
  else
    v_score := 0;
  end if;

  insert into public.submissions (
    team_id, question_id, round, answer, correct, time_taken, score, submitted_at
  ) values (
    p_team_id, p_question_id, 2, upper(trim(p_answer)), v_correct, p_time_taken, v_score, v_now
  ) returning id into v_submission_id;

  return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'correct', v_correct, 'score', v_score);
end;
$$;

-- 6. Round 3 trade submission transaction
create or replace function public.submit_round3_trade_tx(
  p_team_id uuid,
  p_asset text,
  p_account_size numeric,
  p_risk_per_trade numeric,
  p_result_type text,
  p_profit numeric,
  p_loss numeric,
  p_pl_percentage numeric,
  p_proof_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_cfg record;
  v_session record;
  v_current_count integer;
  v_trade_number integer;
  v_trade record;
  v_now timestamptz := clock_timestamp();
begin
  -- Consistent lock order: round1_state first, then event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if coalesce(v_cfg.rounds->'3'->>'state', '') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 3 is not active', 'code', 'NOT_ACTIVE');
  end if;

  select * into v_session from public.round3_sessions where team_id = p_team_id;
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'error', 'Start Round 3 first', 'code', 'NO_SESSION');
  end if;

  if v_now >= v_session.ends_at or v_session.closed then
    return jsonb_build_object('ok', false, 'error', 'Round 3 window has closed', 'code', 'SESSION_CLOSED');
  end if;

  select count(*), coalesce(max(trade_number), 0)
  into v_current_count, v_trade_number
  from public.trades
  where team_id = p_team_id;

  if v_current_count >= coalesce(v_cfg.max_trades, 2) then
    return jsonb_build_object('ok', false, 'error', 'Trade limit reached', 'code', 'TRADE_LIMIT');
  end if;

  v_trade_number := v_trade_number + 1;

  insert into public.trades (
    team_id, trade_number, asset, account_size, risk_per_trade, result_type,
    profit, loss, pl_percentage, verification_status, admin_notes, proof_url, submitted_at
  ) values (
    p_team_id, v_trade_number, p_asset, p_account_size, p_risk_per_trade, upper(trim(p_result_type)),
    p_profit, p_loss, p_pl_percentage, 'PENDING', null, p_proof_url, v_now
  ) returning * into v_trade;

  return jsonb_build_object('ok', true, 'trade', to_jsonb(v_trade));
end;
$$;

-- Permissions for score-changing procedures
revoke all on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) from public;
revoke all on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) from anon;
revoke all on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) from authenticated;
grant execute on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) to service_role;

revoke all on function public.admin_verify_trade_tx(uuid, text, text) from public;
revoke all on function public.admin_verify_trade_tx(uuid, text, text) from anon;
revoke all on function public.admin_verify_trade_tx(uuid, text, text) from authenticated;
grant execute on function public.admin_verify_trade_tx(uuid, text, text) to service_role;

revoke all on function public.admin_delete_trade_tx(uuid) from public;
revoke all on function public.admin_delete_trade_tx(uuid) from anon;
revoke all on function public.admin_delete_trade_tx(uuid) from authenticated;
grant execute on function public.admin_delete_trade_tx(uuid) to service_role;

revoke all on function public.admin_delete_team_tx(uuid) from public;
revoke all on function public.admin_delete_team_tx(uuid) from anon;
revoke all on function public.admin_delete_team_tx(uuid) from authenticated;
grant execute on function public.admin_delete_team_tx(uuid) to service_role;

revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, numeric) from public;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, numeric) from anon;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, numeric) from authenticated;
grant execute on function public.submit_round2_answer_tx(uuid, uuid, text, numeric) to service_role;

revoke all on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text) from public;
revoke all on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text) from anon;
revoke all on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text) from authenticated;
grant execute on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text) to service_role;

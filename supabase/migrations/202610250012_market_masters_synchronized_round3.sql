-- =============================================================================
-- Migration: 202610250012_market_masters_synchronized_round3.sql
-- Description:
-- 1. Create public.round3_state table for synchronized, authoritative Round 3
--    timing shared across all teams.
-- 2. admin_set_round3_state_tx: Shared start, pause/resume, and completion transitions.
-- 3. advance_round3_state_tx: Synchronized expiry and auto-completion.
-- 4. submit_round3_trade_tx: Strict time-window enforcement, row-level team locking,
--    and two-slot (Trade 1 and Trade 2) safety preventing duplicate consumption.
-- 5. Update admin_finalize_results_tx, admin_reset_gameplay_tx, and score-changing RPCs
--    to include round3_state in the consistent global lock hierarchy:
--    round1_state -> round2_state -> round3_state -> event_config
-- =============================================================================

-- 1. Create public.round3_state
create table if not exists public.round3_state (
  id text primary key default 'current',
  version integer not null default 1,
  status text not null default 'IDLE',   -- 'IDLE', 'ACTIVE', 'PAUSED', 'COMPLETED'
  phase text not null default 'WAITING', -- 'WAITING', 'ACTIVE', 'PAUSED', 'COMPLETED'
  round_duration_minutes integer not null default 90,
  phase_start_at timestamptz,
  phase_ends_at timestamptz,
  is_paused boolean not null default false,
  paused_at timestamptz,
  paused_remaining_ms bigint default 0,
  updated_at timestamptz not null default now()
);

-- Seed initial current row with 90-minute default duration
insert into public.round3_state (
  id, version, status, phase, round_duration_minutes, is_paused, paused_remaining_ms, updated_at
)
values (
  'current', 1, 'IDLE', 'WAITING', 90, false, 0, now()
)
on conflict (id) do update set
  round_duration_minutes = 90;

-- RLS: deny public access
alter table public.round3_state enable row level security;

drop policy if exists "deny_public_access" on public.round3_state;
create policy "deny_public_access"
  on public.round3_state
  to anon, authenticated
  using (false)
  with check (false);

-- Update event_config duration to 90 minutes
update public.event_config
set round3_duration_minutes = 90
where id = 'event' and (round3_duration_minutes is null or round3_duration_minutes = 60);

-- 2. admin_set_round3_state_tx
create or replace function public.admin_set_round3_state_tx(
  p_action text,
  p_now timestamptz default clock_timestamp(),
  p_duration_minutes integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_r3_round jsonb;
  v_remaining_ms numeric;
  v_new_ends timestamptz;
  v_duration integer;
  v_started text;
  v_trade_count integer := 0;
begin
  if p_action not in ('UPCOMING', 'ACTIVE', 'PAUSED', 'COMPLETED') then
    return jsonb_build_object('ok', false, 'error', 'Invalid round 3 action', 'code', 'INVALID_ACTION');
  end if;

  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_r3 from public.round3_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_r3.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round 3 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;
  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config record not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Cannot change round state.', 'code', 'FINALIZED');
  end if;

  v_r3_round := coalesce(v_cfg.rounds->'3', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null));

  if p_action = 'UPCOMING' then
    select count(*) into v_trade_count from public.trades;
    if (v_r3.status in ('ACTIVE', 'PAUSED') or v_r3.phase in ('ACTIVE', 'PAUSED') or v_trade_count > 0 or v_r3_round->>'state' in ('ACTIVE', 'PAUSED', 'COMPLETED')) then
      return jsonb_build_object(
        'ok', false,
        'error', 'Cannot set Round 3 to UPCOMING during a running, paused, or completed/played run. Use Reset Gameplay to wipe gameplay data.',
        'code', 'CONTRADICTORY_STATE'
      );
    end if;

    update public.round3_state
    set status = 'IDLE',
        phase = 'WAITING',
        round_duration_minutes = coalesce(p_duration_minutes, 90),
        phase_start_at = null,
        phase_ends_at = null,
        is_paused = false,
        paused_at = null,
        paused_remaining_ms = 0,
        version = version + 1,
        updated_at = p_now
    where id = 'current'
    returning * into v_r3;

    v_r3_round := jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null);

  elsif p_action = 'ACTIVE' then
    if v_r3.is_paused then
      -- Resume from pause: extend deadline by frozen remaining time
      v_remaining_ms := greatest(0::numeric, coalesce(v_r3.paused_remaining_ms, 0));
      v_new_ends := p_now + (v_remaining_ms * interval '1 millisecond');

      update public.round3_state
      set is_paused = false,
          paused_at = null,
          paused_remaining_ms = 0,
          phase_ends_at = v_new_ends,
          status = 'ACTIVE',
          phase = 'ACTIVE',
          version = version + 1,
          updated_at = p_now
      where id = 'current'
      returning * into v_r3;
    else
      -- Fresh start
      v_duration := coalesce(p_duration_minutes, coalesce(v_r3.round_duration_minutes, 90));
      update public.round3_state
      set status = 'ACTIVE',
          phase = 'ACTIVE',
          round_duration_minutes = v_duration,
          phase_start_at = p_now,
          phase_ends_at = p_now + (v_duration * interval '1 minute'),
          is_paused = false,
          paused_at = null,
          paused_remaining_ms = 0,
          version = version + 1,
          updated_at = p_now
      where id = 'current'
      returning * into v_r3;
    end if;

    v_started := coalesce(v_r3_round->>'started_at', to_char(p_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    v_r3_round := jsonb_build_object('state', 'ACTIVE', 'started_at', v_started, 'ended_at', null);

  elsif p_action = 'PAUSED' then
    if (v_r3.status = 'ACTIVE' or v_r3.phase = 'ACTIVE') and not v_r3.is_paused then
      v_remaining_ms := greatest(0::numeric, extract(epoch from (v_r3.phase_ends_at - p_now)) * 1000);
      update public.round3_state
      set is_paused = true,
          paused_at = p_now,
          paused_remaining_ms = v_remaining_ms,
          status = 'PAUSED',
          phase = 'PAUSED',
          version = version + 1,
          updated_at = p_now
      where id = 'current'
      returning * into v_r3;
    end if;

    v_r3_round := jsonb_set(v_r3_round, '{state}', '"PAUSED"');

  elsif p_action = 'COMPLETED' then
    update public.round3_state
    set status = 'COMPLETED',
        phase = 'COMPLETED',
        is_paused = false,
        paused_remaining_ms = 0,
        version = version + 1,
        updated_at = p_now
    where id = 'current'
    returning * into v_r3;

    v_r3_round := jsonb_build_object(
      'state', 'COMPLETED',
      'started_at', v_r3_round->>'started_at',
      'ended_at', to_char(p_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  update public.event_config
  set rounds = jsonb_set(coalesce(rounds, '{}'::jsonb), '{3}', v_r3_round)
  where id = 'event';

  return jsonb_build_object(
    'ok', true,
    'state', to_jsonb(v_r3),
    'round_value', v_r3_round
  );
end;
$$;

-- 3. advance_round3_state_tx
create or replace function public.advance_round3_state_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
begin
  -- Lightweight check without taking exclusive locks for routine unchanged reads
  select * into v_r3 from public.round3_state where id = 'current';

  if v_r3.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round 3 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  if v_r3.is_paused or v_r3.status in ('IDLE', 'COMPLETED') or v_r3.phase in ('WAITING', 'COMPLETED') then
    return to_jsonb(v_r3);
  end if;

  if v_r3.phase_ends_at is null or p_now < v_r3.phase_ends_at then
    return to_jsonb(v_r3);
  end if;

  -- Phase expired: acquire exclusive locks in consistent global order
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_r3 from public.round3_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_r3.is_paused or v_r3.status in ('IDLE', 'COMPLETED') or v_r3.phase in ('WAITING', 'COMPLETED') or (v_r3.phase_ends_at is not null and p_now < v_r3.phase_ends_at) then
    return to_jsonb(v_r3);
  end if;

  update public.round3_state
  set status = 'COMPLETED',
      phase = 'COMPLETED',
      is_paused = false,
      paused_remaining_ms = 0,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_r3;

  update public.event_config
  set rounds = jsonb_set(
    coalesce(rounds, '{}'::jsonb),
    '{3}',
    jsonb_build_object(
      'state', 'COMPLETED',
      'started_at', rounds->'3'->>'started_at',
      'ended_at', to_char(p_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )
  where id = 'event';

  return to_jsonb(v_r3);
end;
$$;

-- 4. submit_round3_trade_tx
create or replace function public.submit_round3_trade_tx(
  p_team_id uuid,
  p_asset text,
  p_account_size numeric,
  p_risk_per_trade numeric,
  p_result_type text,
  p_profit numeric,
  p_loss numeric,
  p_pl_percentage numeric,
  p_proof_url text default null,
  p_trade_number integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_team_check record;
  v_current_count integer := 0;
  v_trade_number integer;
  v_existing record;
  v_trade record;
  v_now timestamptz := clock_timestamp();
  v_norm_result text;
begin
  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_r3 from public.round3_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  -- Row-level lock on the submitting team to serialize concurrent teammate submissions safely
  select * into v_team_check from public.teams where id = p_team_id for update;
  if v_team_check.id is null then
    return jsonb_build_object('ok', false, 'error', 'Team not found', 'code', 'TEAM_NOT_FOUND');
  end if;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if v_r3.is_paused or coalesce(v_cfg.rounds->'3'->>'state', '') = 'PAUSED' or coalesce(v_r3.phase, '') = 'PAUSED' or coalesce(v_r3.status, '') = 'PAUSED' then
    return jsonb_build_object('ok', false, 'error', 'Round 3 is paused', 'code', 'ROUND_PAUSED');
  end if;

  if coalesce(v_cfg.rounds->'3'->>'state', '') <> 'ACTIVE' or coalesce(v_r3.phase, '') <> 'ACTIVE' or coalesce(v_r3.status, '') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 3 is not active', 'code', 'NOT_ACTIVE');
  end if;

  -- Strict server-side time window enforcement: reject after deadline expiry even if status was active
  if v_r3.phase_ends_at is null or v_now >= v_r3.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Round 3 window has closed', 'code', 'DEADLINE_EXPIRED');
  end if;

  -- Validate finite numeric fields
  if p_account_size is null or p_account_size <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Account size must be greater than zero', 'code', 'INVALID_ACCOUNT_SIZE');
  end if;

  if p_risk_per_trade is null or p_risk_per_trade < 0 then
    return jsonb_build_object('ok', false, 'error', 'Risk per trade must be non-negative', 'code', 'INVALID_RISK');
  end if;

  v_norm_result := upper(trim(coalesce(p_result_type, '')));
  if v_norm_result not in ('PROFIT', 'LOSS') then
    return jsonb_build_object('ok', false, 'error', 'Result type must be PROFIT or LOSS', 'code', 'INVALID_RESULT_TYPE');
  end if;

  if v_norm_result = 'PROFIT' and (coalesce(p_profit, 0) <= 0 or coalesce(p_loss, 0) <> 0 or coalesce(p_pl_percentage, 0) <= 0) then
    return jsonb_build_object('ok', false, 'error', 'Profit must be > 0, loss must be 0, and P/L % must be positive for PROFIT', 'code', 'INVALID_PROFIT_VALUES');
  end if;

  if v_norm_result = 'LOSS' and (coalesce(p_loss, 0) <= 0 or coalesce(p_profit, 0) <> 0 or coalesce(p_pl_percentage, 0) >= 0) then
    return jsonb_build_object('ok', false, 'error', 'Loss must be > 0, profit must be 0, and P/L % must be negative for LOSS', 'code', 'INVALID_LOSS_VALUES');
  end if;

  -- Two-slot limit and duplicate/retry safety
  select count(*) into v_current_count from public.trades where team_id = p_team_id;

  if p_trade_number is not null then
    if p_trade_number not in (1, 2) then
      return jsonb_build_object('ok', false, 'error', 'Invalid trade slot number (must be 1 or 2)', 'code', 'INVALID_SLOT');
    end if;

    select * into v_existing from public.trades where team_id = p_team_id and trade_number = p_trade_number;
    if v_existing.id is not null then
      return jsonb_build_object(
        'ok', false,
        'error', format('Trade %s already submitted', p_trade_number),
        'code', 'SLOT_ALREADY_USED',
        'trade', to_jsonb(v_existing)
      );
    end if;

    v_trade_number := p_trade_number;
  else
    select coalesce(min(s), 0)
    into v_trade_number
    from (values (1), (2)) as slots(s)
    where s not in (select trade_number from public.trades where team_id = p_team_id);

    if v_trade_number = 0 or v_current_count >= 2 then
      return jsonb_build_object('ok', false, 'error', 'Trade limit reached (2 trades maximum)', 'code', 'TRADE_LIMIT');
    end if;
  end if;

  insert into public.trades (
    team_id, trade_number, asset, account_size, risk_per_trade, result_type,
    profit, loss, pl_percentage, verification_status, admin_notes, proof_url, submitted_at
  ) values (
    p_team_id, v_trade_number, trim(p_asset), p_account_size, p_risk_per_trade, v_norm_result,
    coalesce(p_profit, 0), coalesce(p_loss, 0), coalesce(p_pl_percentage, 0), 'PENDING', null, p_proof_url, v_now
  ) returning * into v_trade;

  return jsonb_build_object('ok', true, 'trade', to_jsonb(v_trade));
end;
$$;

-- 5. Update admin_finalize_results_tx to check round3_state and lock order
create or replace function public.admin_finalize_results_tx()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_pending integer := 0;
begin
  -- Consistent lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_r3 from public.round3_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config record not found', 'code', 'CONFIG_MISSING');
  end if;

  -- 1. Require all rounds to be closed (COMPLETED) in event_config
  if coalesce(v_cfg.rounds->'1'->>'state', '') <> 'COMPLETED'
     or coalesce(v_cfg.rounds->'2'->>'state', '') <> 'COMPLETED'
     or coalesce(v_cfg.rounds->'3'->>'state', '') <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: all rounds must be completed first', 'code', 'ROUNDS_NOT_COMPLETED');
  end if;

  -- Verify Round 1 state is not active, in countdown, or paused
  if v_r1.id is not null and (v_r1.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_r1.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: Round 1 is still in progress', 'code', 'R1_ACTIVE');
  end if;

  -- Verify Round 2 state is not active, in countdown, or paused
  if v_r2.id is not null and (v_r2.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_r2.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: Round 2 is still in progress', 'code', 'R2_ACTIVE');
  end if;

  -- Verify Round 3 state is not active or paused
  if v_r3.id is not null and (v_r3.status in ('ACTIVE', 'PAUSED') or v_r3.phase in ('ACTIVE', 'PAUSED') or v_r3.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot finalize results: Round 3 is still in progress', 'code', 'R3_ACTIVE');
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

-- 6. Update admin_reset_gameplay_tx to reset round3_state and lock order
create or replace function public.admin_reset_gameplay_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_rounds jsonb;
  v_q1_count integer := 0;
  v_q2_count integer := 0;
begin
  -- Acquire locks FIRST before deleting records (round1_state -> round2_state -> round3_state -> event_config)
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_r3 from public.round3_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  -- Delete all participant submissions, trades, sessions, overrides
  delete from public.submissions where team_id is not null;
  delete from public.trades where team_id is not null;
  delete from public.round3_sessions where team_id is not null;
  delete from public.score_overrides where team_id is not null;
  delete from public.leaderboard_snapshot where team_id is not null;

  -- Determine actual configured question counts
  select count(*) into v_q1_count from public.questions where round = 1;
  select count(*) into v_q2_count from public.questions where round = 2;

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
      total_questions = coalesce(v_q1_count, 0),
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
  returning * into v_r1;

  update public.round2_state
  set status = 'IDLE',
      phase = 'WAITING',
      current_question_index = 0,
      current_question_id = null,
      total_questions = coalesce(v_q2_count, 0),
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
  returning * into v_r2;

  update public.round3_state
  set status = 'IDLE',
      phase = 'WAITING',
      round_duration_minutes = 90,
      phase_start_at = null,
      phase_ends_at = null,
      is_paused = false,
      paused_at = null,
      paused_remaining_ms = 0,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_r3;

  return jsonb_build_object(
    'ok', true,
    'round1_state', to_jsonb(v_r1),
    'round2_state', to_jsonb(v_r2),
    'round3_state', to_jsonb(v_r3)
  );
end;
$$;

-- 7. Update admin_verify_trade_tx to include round3_state lock
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
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_trade record;
begin
  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_r3 from public.round3_state where id = 'current' for share;
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

-- 8. Update admin_delete_trade_tx to include round3_state lock
create or replace function public.admin_delete_trade_tx(
  p_trade_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_trade record;
begin
  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_r3 from public.round3_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before deleting trades.', 'code', 'FINALIZED');
  end if;

  delete from public.trades
  where id = p_trade_id
  returning * into v_trade;

  if v_trade.id is null then
    return jsonb_build_object('ok', false, 'error', 'Trade not found', 'code', 'NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'trade_id', v_trade.id, 'team_id', v_trade.team_id);
end;
$$;

-- 9. Update admin_set_score_override_tx to include round3_state lock
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
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
begin
  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_r3 from public.round3_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before modifying scores.', 'code', 'FINALIZED');
  end if;

  insert into public.score_overrides (team_id, round, new_score, reason, updated_at)
  values (p_team_id, p_round, p_new_score, p_reason, p_now)
  on conflict (team_id, round) do update set
    new_score = EXCLUDED.new_score,
    reason = EXCLUDED.reason,
    updated_at = EXCLUDED.updated_at;

  return jsonb_build_object('ok', true);
end;
$$;

-- 10. Update admin_delete_team_tx to include round3_state lock
create or replace function public.admin_delete_team_tx(
  p_team_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_r3 record;
  v_cfg record;
  v_team record;
begin
  -- Consistent global lock order: round1_state -> round2_state -> round3_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_r3 from public.round3_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before deleting teams.', 'code', 'FINALIZED');
  end if;

  delete from public.teams
  where id = p_team_id
  returning * into v_team;

  if v_team.id is null then
    return jsonb_build_object('ok', false, 'error', 'Team not found', 'code', 'NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'team_name', v_team.team_name, 'owner_user_id', v_team.owner_user_id);
end;
$$;

-- 11. Revoke and Grant Permissions (Service role only)
revoke all on function public.admin_set_round3_state_tx(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.admin_set_round3_state_tx(text, timestamptz, integer) to service_role;

revoke all on function public.advance_round3_state_tx(timestamptz) from public, anon, authenticated;
grant execute on function public.advance_round3_state_tx(timestamptz) to service_role;

revoke all on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text, integer) from public, anon, authenticated;
grant execute on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text, integer) to service_role;

revoke all on function public.admin_finalize_results_tx() from public, anon, authenticated;
grant execute on function public.admin_finalize_results_tx() to service_role;

revoke all on function public.admin_reset_gameplay_tx(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_reset_gameplay_tx(timestamptz) to service_role;

revoke all on function public.admin_verify_trade_tx(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_verify_trade_tx(uuid, text, text) to service_role;

revoke all on function public.admin_delete_trade_tx(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_trade_tx(uuid) to service_role;

revoke all on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_set_score_override_tx(uuid, integer, numeric, text, timestamptz) to service_role;

revoke all on function public.admin_delete_team_tx(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_team_tx(uuid) to service_role;

-- Migration 202610250013: Round 3 Authoritative P/L Calculation, Validation, and Legacy Overload Cleanup
-- Converges the database schema by dropping legacy 9-argument submit_round3_trade_tx and installing
-- authoritative server-side P/L calculation, 0.05% tolerance validation, and strict serialization.

-- 1. Drop obsolete 9-argument overload from migration 0003/0008 (which checked deprecated round3_sessions)
drop function if exists public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text);

-- 2. Define authoritative submit_round3_trade_tx (10 arguments)
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
  v_expected_pl numeric;
  v_final_pl numeric;
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

  -- Authoritative P/L percentage agreement check (100 * (profit - loss) / account_size within 0.05% tolerance)
  v_expected_pl := (100.0 * (coalesce(p_profit, 0) - coalesce(p_loss, 0))) / p_account_size;
  if p_pl_percentage is not null and abs(p_pl_percentage - v_expected_pl) > 0.05 then
    return jsonb_build_object(
      'ok', false,
      'error', format('Submitted P/L percentage (%s%%) does not agree with calculated return from profit/loss and account size (%s%%)', p_pl_percentage, round(v_expected_pl, 2)),
      'code', 'PL_MISMATCH'
    );
  end if;

  v_final_pl := round(v_expected_pl, 2);

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
    coalesce(p_profit, 0), coalesce(p_loss, 0), v_final_pl, 'PENDING', null, p_proof_url, v_now
  ) returning * into v_trade;

  return jsonb_build_object('ok', true, 'trade', to_jsonb(v_trade));
end;
$$;

-- 3. Execution permissions: service_role only
revoke all on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text, integer) from public, anon, authenticated;
grant execute on function public.submit_round3_trade_tx(uuid, text, numeric, numeric, text, numeric, numeric, numeric, text, integer) to service_role;

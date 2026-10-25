-- Migration: 202610250007_market_masters_synchronized_round1.sql
-- Synchronized Round 1 schedule, state tracking, and atomic submission procedure
-- Enforces service_role-only execution, safe search_path, checked state/version updates,
-- strict timestamp bounds (start <= now < end), frozen question set, and pause-immune speed scoring.

begin;

create table if not exists public.round1_state (
  id text primary key default 'current',
  version integer not null default 1,
  status text not null default 'IDLE' check (status in ('IDLE', 'COUNTDOWN', 'ACTIVE', 'PAUSED', 'COMPLETED')),
  phase text not null default 'WAITING' check (phase in ('WAITING', 'COUNTDOWN', 'QUESTION', 'RESULT', 'COMPLETED')),
  current_question_index integer not null default 0,
  current_question_id uuid references public.questions(id) on delete set null,
  total_questions integer not null default 0,
  phase_start_at timestamptz,
  phase_ends_at timestamptz,
  is_paused boolean not null default false,
  paused_at timestamptz,
  pause_phase text,
  paused_remaining_ms integer not null default 0,
  countdown_seconds integer not null default 10,
  result_seconds integer not null default 10,
  closed_question_ids uuid[] not null default array[]::uuid[],
  frozen_questions jsonb,
  speed_bonus_pct numeric not null default 0.5,
  updated_at timestamptz not null default now()
);

-- Seed single row for Round 1 durable state with initial version 1
insert into public.round1_state (
  id, version, status, phase, current_question_index, total_questions,
  is_paused, paused_remaining_ms, countdown_seconds, result_seconds,
  closed_question_ids
)
values ('current', 1, 'IDLE', 'WAITING', 0, 0, false, 0, 10, 10, array[]::uuid[])
on conflict (id) do nothing;

-- Ensure columns exist if table was previously created
alter table public.round1_state add column if not exists closed_question_ids uuid[] not null default array[]::uuid[];
alter table public.round1_state add column if not exists frozen_questions jsonb;
alter table public.round1_state add column if not exists speed_bonus_pct numeric not null default 0.5;

-- RLS for round1_state
alter table public.round1_state enable row level security;
revoke all on table public.round1_state from public, anon, authenticated;

drop policy if exists deny_public_round1_state on public.round1_state;
create policy deny_public_round1_state
  on public.round1_state
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Atomic submission function with strict server clock, search_path isolation, and race condition prevention
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

  if v_state is null or v_state.is_paused or v_state.status <> 'ACTIVE' or v_state.phase <> 'QUESTION' then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently open', 'code', 'NOT_OPEN');
  end if;

  -- Verify event_config round 1 is active (Stop Event immediately rejects submissions)
  select * into v_event from public.event_config where id = 'event' for share;
  if v_event is not null and (v_event.rounds->'1'->>'state') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 1 is not active', 'code', 'NOT_OPEN');
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

  -- 3. Check for existing team submission (first response per team counts)
  if exists (select 1 from public.submissions where team_id = p_team_id and question_id = p_question_id) then
    return jsonb_build_object('ok', false, 'error', 'Already submitted', 'code', 'ALREADY_SUBMITTED');
  end if;

  -- 4. Fetch question details from frozen question set if available, else from questions table
  v_limit := null;
  v_base_points := 100;
  v_correct_answer := null;

  if v_state.frozen_questions is not null and jsonb_typeof(v_state.frozen_questions) = 'array' then
    for v_item in select * from jsonb_array_elements(v_state.frozen_questions) loop
      if (v_item->>'id')::uuid = p_question_id then
        v_limit := (v_item->>'time_limit')::numeric;
        v_base_points := coalesce((v_item->>'base_points')::numeric, 100);
        v_correct_answer := v_item->>'correct_answer';
        exit;
      end if;
    end loop;
  end if;

  if v_limit is null then
    select * into v_question
    from public.questions
    where id = p_question_id and round = 1;

    if v_question is null then
      return jsonb_build_object('ok', false, 'error', 'Question not found', 'code', 'NOT_FOUND');
    end if;

    v_limit := v_question.time_limit;
    v_base_points := coalesce(v_question.base_points, 100);
    v_correct_answer := v_question.correct_answer;
  end if;

  if v_limit is null or v_limit <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Invalid question time limit', 'code', 'INVALID_TIME_LIMIT');
  end if;

  -- 5. Speed bonus pct from frozen state or event_config
  v_speed_bonus := coalesce(v_state.speed_bonus_pct, v_event.speed_bonus_pct, 0.5);

  -- 6. Calculate time_taken using active remaining time to ensure paused duration never penalizes speed scoring
  v_remaining_seconds := greatest(0::numeric, extract(epoch from (v_state.phase_ends_at - v_now))::numeric);
  v_time_taken := greatest(0::numeric, round(
    least(v_limit, greatest(0::numeric, v_limit - v_remaining_seconds)),
    2
  ));

  v_correct := (upper(trim(p_answer)) = upper(trim(v_correct_answer)));
  v_speed_factor := greatest(0::numeric, 1 - (v_time_taken / greatest(1::numeric, v_limit)));
  v_score := case when v_correct then round(v_base_points * (1 + v_speed_bonus * v_speed_factor)) else 0 end;

  -- 7. Insert submission atomically; handle simultaneous teammate submissions cleanly
  begin
    insert into public.submissions (
      team_id, question_id, round, answer, correct, time_taken, score, submitted_at
    ) values (
      p_team_id, p_question_id, 1, upper(trim(p_answer)), v_correct, v_time_taken, v_score, v_now
    )
    returning id into v_submission_id;
  exception when unique_violation then
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

-- Procedural transactional phase advancement with row lock across edge instances
create or replace function public.advance_round1_state_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_q record;
  v_q_count integer;
  v_cur_phase text;
  v_cur_status text;
  v_cur_index integer;
  v_cur_qid uuid;
  v_cur_start timestamptz;
  v_cur_ends timestamptz;
  v_safety integer := 0;
  v_limit integer;
  v_closed_ids uuid[];
  v_item jsonb;
begin
  -- Lock row exclusively
  select * into v_state
  from public.round1_state
  where id = 'current'
  for update;

  if v_state is null then
    return jsonb_build_object('ok', false, 'error', 'Round 1 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  if v_state.is_paused or v_state.status in ('IDLE', 'COMPLETED') or v_state.phase in ('WAITING', 'COMPLETED') then
    return to_jsonb(v_state);
  end if;

  if v_state.phase_ends_at is null or p_now < v_state.phase_ends_at then
    return to_jsonb(v_state);
  end if;

  -- Load question count from frozen set if available, else from questions table
  if v_state.frozen_questions is not null and jsonb_typeof(v_state.frozen_questions) = 'array' then
    v_q_count := jsonb_array_length(v_state.frozen_questions);
  else
    select count(*) into v_q_count from public.questions where round = 1;
  end if;

  if v_q_count = 0 then
    update public.round1_state
    set status = 'COMPLETED', phase = 'COMPLETED', current_question_id = null, is_paused = false,
        version = version + 1, updated_at = p_now
    where id = 'current'
    returning * into v_state;

    update public.event_config
    set rounds = jsonb_set(
      coalesce(rounds, '{}'::jsonb),
      '{1}',
      jsonb_build_object('state', 'COMPLETED', 'started_at', rounds->'1'->>'started_at', 'ended_at', p_now)
    )
    where id = 'event';

    return to_jsonb(v_state);
  end if;

  v_cur_phase := v_state.phase;
  v_cur_status := v_state.status;
  v_cur_index := v_state.current_question_index;
  v_cur_qid := v_state.current_question_id;
  v_cur_ends := v_state.phase_ends_at;
  v_closed_ids := coalesce(v_state.closed_question_ids, array[]::uuid[]);

  while p_now >= v_cur_ends and v_safety < (v_q_count * 2 + 5) loop
    v_safety := v_safety + 1;
    if v_cur_phase = 'COUNTDOWN' then
      v_cur_phase := 'QUESTION';
      v_cur_status := 'ACTIVE';
      v_cur_index := 0;

      if v_state.frozen_questions is not null then
        v_item := v_state.frozen_questions->0;
        v_cur_qid := (v_item->>'id')::uuid;
        v_limit := coalesce((v_item->>'time_limit')::integer, 30);
      else
        select * into v_q from public.questions where round = 1 order by question_order asc, created_at asc, id asc limit 1;
        v_cur_qid := v_q.id;
        v_limit := coalesce(v_q.time_limit, 30);
      end if;

      v_cur_start := v_cur_ends;
      v_cur_ends := v_cur_start + (v_limit * interval '1 second');
    elsif v_cur_phase = 'QUESTION' then
      v_cur_phase := 'RESULT';
      -- Mark question as genuinely CLOSED
      if v_cur_qid is not null and not (v_cur_qid = any(v_closed_ids)) then
        v_closed_ids := array_append(v_closed_ids, v_cur_qid);
      end if;

      v_cur_start := v_cur_ends;
      v_cur_ends := v_cur_start + (coalesce(v_state.result_seconds, 10) * interval '1 second');
    elsif v_cur_phase = 'RESULT' then
      v_cur_index := v_cur_index + 1;
      if v_cur_index < v_q_count then
        v_cur_phase := 'QUESTION';

        if v_state.frozen_questions is not null then
          v_item := v_state.frozen_questions->v_cur_index;
          v_cur_qid := (v_item->>'id')::uuid;
          v_limit := coalesce((v_item->>'time_limit')::integer, 30);
        else
          select * into v_q from public.questions where round = 1 order by question_order asc, created_at asc, id asc offset v_cur_index limit 1;
          v_cur_qid := v_q.id;
          v_limit := coalesce(v_q.time_limit, 30);
        end if;

        v_cur_start := v_cur_ends;
        v_cur_ends := v_cur_start + (v_limit * interval '1 second');
      else
        v_cur_phase := 'COMPLETED';
        v_cur_status := 'COMPLETED';
        v_cur_qid := null;
        v_cur_start := v_cur_ends;
        v_cur_ends := null;
        exit;
      end if;
    else
      exit;
    end if;
  end loop;

  update public.round1_state
  set status = v_cur_status,
      phase = v_cur_phase,
      current_question_index = v_cur_index,
      current_question_id = v_cur_qid,
      total_questions = v_q_count,
      phase_start_at = v_cur_start,
      phase_ends_at = v_cur_ends,
      is_paused = false,
      paused_remaining_ms = 0,
      pause_phase = null,
      closed_question_ids = v_closed_ids,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_state;

  if v_cur_phase = 'COMPLETED' then
    update public.event_config
    set rounds = jsonb_set(
      coalesce(rounds, '{}'::jsonb),
      '{1}',
      jsonb_build_object('state', 'COMPLETED', 'started_at', rounds->'1'->>'started_at', 'ended_at', p_now)
    )
    where id = 'event';
  end if;

  return to_jsonb(v_state);
end;
$$;

-- Atomic Stop Event procedure: stops R1 and event_config in a single transaction
create or replace function public.admin_stop_event_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg record;
  v_state record;
  v_rounds jsonb;
begin
  select * into v_cfg from public.event_config where id = 'event' for update;
  select * into v_state from public.round1_state where id = 'current' for update;

  v_rounds := coalesce(v_cfg.rounds, '{}'::jsonb);
  v_rounds := jsonb_set(v_rounds, '{1}', jsonb_build_object('state', 'COMPLETED', 'started_at', v_rounds->'1'->>'started_at', 'ended_at', p_now));
  v_rounds := jsonb_set(v_rounds, '{2}', jsonb_build_object('state', 'COMPLETED', 'started_at', v_rounds->'2'->>'started_at', 'ended_at', p_now));
  v_rounds := jsonb_set(v_rounds, '{3}', jsonb_build_object('state', 'COMPLETED', 'started_at', v_rounds->'3'->>'started_at', 'ended_at', p_now));

  update public.event_config
  set registration_open = false,
      rounds = v_rounds
  where id = 'event';

  update public.round1_state
  set status = 'COMPLETED',
      phase = 'COMPLETED',
      is_paused = false,
      paused_remaining_ms = 0,
      pause_phase = null,
      current_question_id = null,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_state;

  return to_jsonb(v_state);
end;
$$;

-- Atomic Reset Gameplay procedure: deletes gameplay data and resets state in a single transaction
create or replace function public.admin_reset_gameplay_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rounds jsonb;
  v_state record;
begin
  -- Delete all participant submissions, trades, sessions, overrides
  delete from public.submissions where team_id is not null;
  delete from public.trades where team_id is not null;
  delete from public.round3_sessions where team_id is not null;
  delete from public.score_overrides where team_id is not null;
  delete from public.leaderboard_snapshot where team_id is not null;

  v_rounds := jsonb_build_object(
    '1', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null),
    '2', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null),
    '3', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null)
  );

  update public.event_config
  set rounds = v_rounds
  where id = 'event';

  update public.round1_state
  set status = 'IDLE',
      phase = 'WAITING',
      current_question_index = 0,
      current_question_id = null,
      total_questions = 0,
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

-- Restrict execution: only service_role (used by Edge Function) may call these procedures.
-- PUBLIC, anon, and authenticated users are revoked to prevent spoofing p_team_id or tampering with round timing directly.
revoke all on function public.submit_round1_answer(uuid, uuid, text) from public;
revoke all on function public.submit_round1_answer(uuid, uuid, text) from anon;
revoke all on function public.submit_round1_answer(uuid, uuid, text) from authenticated;
grant execute on function public.submit_round1_answer(uuid, uuid, text) to service_role;

revoke all on function public.advance_round1_state_tx(timestamptz) from public;
revoke all on function public.advance_round1_state_tx(timestamptz) from anon;
revoke all on function public.advance_round1_state_tx(timestamptz) from authenticated;
grant execute on function public.advance_round1_state_tx(timestamptz) to service_role;

revoke all on function public.admin_stop_event_tx(timestamptz) from public;
revoke all on function public.admin_stop_event_tx(timestamptz) from anon;
revoke all on function public.admin_stop_event_tx(timestamptz) from authenticated;
grant execute on function public.admin_stop_event_tx(timestamptz) to service_role;

revoke all on function public.admin_reset_gameplay_tx(timestamptz) from public;
revoke all on function public.admin_reset_gameplay_tx(timestamptz) from anon;
revoke all on function public.admin_reset_gameplay_tx(timestamptz) from authenticated;
grant execute on function public.admin_reset_gameplay_tx(timestamptz) to service_role;

commit;

-- Migration 0009: Synchronized Round 2 ("THE CALL")
-- Implements durable server-authoritative round2_state, transactional submissions,
-- synchronized state machine with configurable duration, single-line explanation validation,
-- fixed scoring (1 point for correct BUY/SELL, 0 for wrong/unanswered/NO_TRADE, no speed bonus),
-- and updates global lock ordering across all procedures: round1_state -> round2_state -> event_config.

begin;

-- 1. Table public.round2_state
create table if not exists public.round2_state (
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
  question_seconds integer not null default 120,
  result_seconds integer not null default 10,
  closed_question_ids uuid[] not null default array[]::uuid[],
  frozen_questions jsonb,
  updated_at timestamptz not null default now()
);

-- Seed single row for Round 2 durable state
insert into public.round2_state (
  id, version, status, phase, current_question_index, total_questions,
  is_paused, paused_remaining_ms, countdown_seconds, question_seconds, result_seconds,
  closed_question_ids
)
values ('current', 1, 'IDLE', 'WAITING', 0, 0, false, 0, 10, 120, 10, array[]::uuid[])
on conflict (id) do nothing;

-- Ensure columns exist if table was previously partially defined
alter table public.round2_state add column if not exists closed_question_ids uuid[] not null default array[]::uuid[];
alter table public.round2_state add column if not exists frozen_questions jsonb;
alter table public.round2_state add column if not exists question_seconds integer not null default 120;

-- Ensure explanation column exists on public.submissions
alter table public.submissions add column if not exists explanation text;

-- Drop old placeholder overload of submit_round2_answer_tx with numeric time_taken
drop function if exists public.submit_round2_answer_tx(uuid, uuid, text, numeric);

-- RLS for round2_state
alter table public.round2_state enable row level security;
revoke all on table public.round2_state from public, anon, authenticated;

drop policy if exists deny_public_round2_state on public.round2_state;
create policy deny_public_round2_state
  on public.round2_state
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- 2. Transactional Round 2 State advancement procedure
create or replace function public.advance_round2_state_tx(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_state record;
  v_cfg record;
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
  -- Global consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_state from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_state.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round 2 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  if v_state.is_paused or v_state.status in ('IDLE', 'COMPLETED') or v_state.phase in ('WAITING', 'COMPLETED') then
    return to_jsonb(v_state);
  end if;

  if v_state.phase_ends_at is null or p_now < v_state.phase_ends_at then
    return to_jsonb(v_state);
  end if;

  -- Load question count from frozen snapshot if available, else from questions table
  if v_state.frozen_questions is not null and jsonb_typeof(v_state.frozen_questions) = 'array' then
    v_q_count := jsonb_array_length(v_state.frozen_questions);
  else
    select count(*) into v_q_count from public.questions where round = 2;
  end if;

  if v_q_count = 0 then
    update public.round2_state
    set status = 'COMPLETED', phase = 'COMPLETED', current_question_id = null, is_paused = false,
        version = version + 1, updated_at = p_now
    where id = 'current'
    returning * into v_state;

    update public.event_config
    set rounds = jsonb_set(
      coalesce(rounds, '{}'::jsonb),
      '{2}',
      jsonb_build_object('state', 'COMPLETED', 'started_at', rounds->'2'->>'started_at', 'ended_at', p_now)
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
        v_limit := coalesce((v_item->>'time_limit')::integer, coalesce(v_state.question_seconds, 120));
      else
        select * into v_q from public.questions where round = 2 order by question_order asc, created_at asc, id asc limit 1;
        v_cur_qid := v_q.id;
        v_limit := coalesce(v_q.time_limit, coalesce(v_state.question_seconds, 120));
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
          v_limit := coalesce((v_item->>'time_limit')::integer, coalesce(v_state.question_seconds, 120));
        else
          select * into v_q from public.questions where round = 2 order by question_order asc, created_at asc, id asc offset v_cur_index limit 1;
          v_cur_qid := v_q.id;
          v_limit := coalesce(v_q.time_limit, coalesce(v_state.question_seconds, 120));
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

  update public.round2_state
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
      '{2}',
      jsonb_build_object('state', 'COMPLETED', 'started_at', rounds->'2'->>'started_at', 'ended_at', p_now)
    )
    where id = 'event';
  end if;

  return to_jsonb(v_state);
end;
$$;

-- 3. Atomic Round 2 State transition procedure
create or replace function public.admin_set_round2_state_tx(
  p_action text, -- 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'UPCOMING'
  p_now timestamptz default clock_timestamp(),
  p_frozen_questions jsonb default null,
  p_question_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_state record;
  v_cfg record;
  v_rounds jsonb;
  v_r2_round jsonb;
  v_remaining_ms numeric;
  v_new_ends timestamptz;
  v_new_start timestamptz;
  v_limit_sec integer;
  v_first_item jsonb;
begin
  -- Global consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_state from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_state.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round 2 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  -- Advance any elapsed phases using authoritative database time first before changing state
  if not v_state.is_paused and v_state.status in ('ACTIVE', 'COUNTDOWN') and v_state.phase_ends_at is not null and p_now >= v_state.phase_ends_at then
    perform public.advance_round2_state_tx(p_now);
    select * into v_state from public.round2_state where id = 'current' for update;
    select * into v_cfg from public.event_config where id = 'event' for update;
  end if;

  v_rounds := coalesce(v_cfg.rounds, '{}'::jsonb);
  v_r2_round := coalesce(v_rounds->'2', jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null));

  if p_action = 'ACTIVE' then
    if v_state.status = 'COMPLETED' or v_state.phase = 'COMPLETED' then
      return jsonb_build_object('ok', false, 'error', 'Round 2 is completed. To start a new run, perform an explicit Reset Gameplay first.', 'code', 'ROUND_COMPLETED');
    end if;

    if v_state.status in ('ACTIVE', 'COUNTDOWN') and not v_state.is_paused then
      -- Idempotent: already running
      return jsonb_build_object('ok', true, 'state', to_jsonb(v_state), 'rounds', v_rounds, 'round_value', v_r2_round);
    end if;

    if v_state.is_paused then
      -- Resume
      v_remaining_ms := greatest(0::numeric, coalesce(v_state.paused_remaining_ms, 0));
      if v_remaining_ms = 0 then
        update public.round2_state
        set is_paused = false,
            paused_at = null,
            paused_remaining_ms = 0,
            pause_phase = null,
            phase_ends_at = p_now,
            status = case when v_state.pause_phase = 'COUNTDOWN' then 'COUNTDOWN' else 'ACTIVE' end,
            version = version + 1,
            updated_at = p_now
        where id = 'current'
        returning * into v_state;
      else
        v_new_ends := p_now + (v_remaining_ms * interval '1 millisecond');
        v_new_start := v_state.phase_start_at;

        if v_state.pause_phase = 'QUESTION' and v_state.current_question_id is not null then
          v_limit_sec := coalesce(v_state.question_seconds, 120);
          if v_state.frozen_questions is not null then
            for v_first_item in select * from jsonb_array_elements(v_state.frozen_questions) loop
              if (v_first_item->>'id')::uuid = v_state.current_question_id then
                v_limit_sec := coalesce((v_first_item->>'time_limit')::integer, coalesce(v_state.question_seconds, 120));
                exit;
              end if;
            end loop;
          end if;
          v_new_start := v_new_ends - (v_limit_sec * interval '1 second');
        end if;

        update public.round2_state
        set is_paused = false,
            paused_at = null,
            paused_remaining_ms = 0,
            pause_phase = null,
            phase_start_at = v_new_start,
            phase_ends_at = v_new_ends,
            status = case when v_state.pause_phase = 'COUNTDOWN' then 'COUNTDOWN' else 'ACTIVE' end,
            version = version + 1,
            updated_at = p_now
        where id = 'current'
        returning * into v_state;
      end if;
    else
      -- Fresh start
      if p_frozen_questions is null or jsonb_array_length(p_frozen_questions) = 0 then
        return jsonb_build_object('ok', false, 'error', 'No Round 2 questions configured', 'code', 'NO_QUESTIONS');
      end if;

      v_first_item := p_frozen_questions->0;
      update public.round2_state
      set status = 'COUNTDOWN',
          phase = 'COUNTDOWN',
          current_question_index = 0,
          current_question_id = (v_first_item->>'id')::uuid,
          total_questions = jsonb_array_length(p_frozen_questions),
          phase_start_at = p_now,
          phase_ends_at = p_now + (coalesce(v_state.countdown_seconds, 10) * interval '1 second'),
          is_paused = false,
          paused_at = null,
          paused_remaining_ms = 0,
          pause_phase = null,
          closed_question_ids = array[]::uuid[],
          frozen_questions = p_frozen_questions,
          question_seconds = coalesce(p_question_seconds, 120),
          version = version + 1,
          updated_at = p_now
      where id = 'current'
      returning * into v_state;
    end if;

    v_r2_round := jsonb_set(v_r2_round, '{state}', '"ACTIVE"');
    if v_r2_round->>'started_at' is null then
      v_r2_round := jsonb_set(v_r2_round, '{started_at}', to_jsonb(to_char(p_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    end if;

  elsif p_action = 'PAUSED' then
    if (v_state.status in ('ACTIVE', 'COUNTDOWN')) and not v_state.is_paused then
      v_remaining_ms := greatest(0::numeric, extract(epoch from (v_state.phase_ends_at - p_now)) * 1000);
      update public.round2_state
      set is_paused = true,
          paused_at = p_now,
          pause_phase = v_state.phase,
          paused_remaining_ms = v_remaining_ms,
          status = 'PAUSED',
          version = version + 1,
          updated_at = p_now
      where id = 'current'
      returning * into v_state;
    end if;

    v_r2_round := jsonb_set(v_r2_round, '{state}', '"PAUSED"');

  elsif p_action = 'COMPLETED' then
    update public.round2_state
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

    v_r2_round := jsonb_set(v_r2_round, '{state}', '"COMPLETED"');
    if v_r2_round->>'ended_at' is null then
      v_r2_round := jsonb_set(v_r2_round, '{ended_at}', to_jsonb(to_char(p_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    end if;

  elsif p_action = 'UPCOMING' then
    v_r2_round := jsonb_set(v_r2_round, '{state}', '"UPCOMING"');
  end if;

  v_rounds := jsonb_set(v_rounds, '{2}', v_r2_round);
  update public.event_config
  set rounds = v_rounds
  where id = 'event';

  return jsonb_build_object('ok', true, 'state', to_jsonb(v_state), 'rounds', v_rounds, 'round_value', v_r2_round);
end;
$$;

-- 4. Atomic Round 2 submission procedure
-- Enforces:
-- 1. Global share lock: round1_state -> round2_state -> event_config
-- 2. Results finalization rejection
-- 3. Round 2 ACTIVE status, QUESTION phase, current active question ID, active deadline (start <= now < end)
-- 4. Single accepted submission per team/question (duplicate handled cleanly via code ALREADY_SUBMITTED)
-- 5. Strict answer validation: BUY, SELL, NO_TRADE only (no HOLD)
-- 6. Mandatory explanation: plain text, single line (!~ '[\r\n]'), 1..250 characters
-- 7. Fixed scoring: 1 point for correct BUY/SELL, 0 points for wrong, unanswered, or NO_TRADE. No speed bonus.
-- 8. Returns only submission acknowledgement and accepted answer (zero result leak during question phase).
create or replace function public.submit_round2_answer_tx(
  p_team_id uuid,
  p_question_id uuid,
  p_answer text,
  p_explanation text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_state record;
  v_event record;
  v_question record;
  v_now timestamptz := clock_timestamp();
  v_time_taken numeric;
  v_correct boolean;
  v_score numeric;
  v_submission_id uuid;
  v_correct_answer text;
  v_norm_answer text;
  v_norm_explanation text;
  v_fq jsonb;
  v_item jsonb;
begin
  -- 1. Read locks in global consistent order
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_state from public.round2_state where id = 'current' for share;
  select * into v_event from public.event_config where id = 'event' for share;

  if v_event.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_event.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if coalesce(v_event.rounds->'2'->>'state', '') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 2 is not active', 'code', 'NOT_ACTIVE');
  end if;

  if v_state.id is null or v_state.is_paused or v_state.status <> 'ACTIVE' or v_state.phase <> 'QUESTION' then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently open', 'code', 'NOT_OPEN');
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

  -- 4. Validate answer option: BUY, SELL, NO_TRADE only (no HOLD)
  v_norm_answer := upper(trim(coalesce(p_answer, '')));
  if v_norm_answer not in ('BUY', 'SELL', 'NO_TRADE') then
    return jsonb_build_object('ok', false, 'error', 'Invalid option. Must be BUY, SELL, or NO_TRADE.', 'code', 'INVALID_OPTION');
  end if;

  -- 5. Validate explanation: mandatory, unscored, plain text, one line, maximum 250 characters
  v_norm_explanation := trim(coalesce(p_explanation, ''));
  if length(v_norm_explanation) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Explanation is mandatory.', 'code', 'EXPLANATION_REQUIRED');
  end if;

  if length(v_norm_explanation) > 250 then
    return jsonb_build_object('ok', false, 'error', 'Explanation must not exceed 250 characters.', 'code', 'EXPLANATION_TOO_LONG');
  end if;

  -- Check for newline or carriage return characters
  if v_norm_explanation ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'error', 'Explanation must be a single line.', 'code', 'EXPLANATION_MULTILINE');
  end if;

  -- 6. Fetch question details from frozen question set if available, else from questions table
  v_correct_answer := null;
  if v_state.frozen_questions is not null and jsonb_typeof(v_state.frozen_questions) = 'array' then
    for v_item in select * from jsonb_array_elements(v_state.frozen_questions) loop
      if (v_item->>'id')::uuid = p_question_id then
        v_correct_answer := v_item->>'correct_answer';
        exit;
      end if;
    end loop;
  end if;

  if v_correct_answer is null then
    select * into v_question
    from public.questions
    where id = p_question_id and round = 2;

    if v_question.id is null then
      return jsonb_build_object('ok', false, 'error', 'Question not found', 'code', 'NOT_FOUND');
    end if;

    v_correct_answer := v_question.correct_answer;
  end if;

  -- 7. Calculate server-authoritative time_taken
  v_time_taken := round(extract(epoch from (v_now - v_state.phase_start_at))::numeric, 2);
  if v_time_taken < 0 then
    v_time_taken := 0;
  end if;

  -- 8. Fixed scoring:
  -- Correct BUY/SELL: 1 point.
  -- Wrong, unanswered or NO_TRADE: 0 points.
  -- No negative points, no speed bonus.
  if v_norm_answer in ('BUY', 'SELL') and v_norm_answer = upper(trim(coalesce(v_correct_answer, ''))) then
    v_correct := true;
    v_score := 1;
  else
    v_correct := false;
    v_score := 0;
  end if;

  -- 9. Insert submission with clean concurrent teammate race handling
  begin
    insert into public.submissions (
      team_id, question_id, round, answer, explanation, correct, time_taken, score, submitted_at
    ) values (
      p_team_id, p_question_id, 2, v_norm_answer, v_norm_explanation, v_correct, v_time_taken, v_score, v_now
    ) returning id into v_submission_id;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'Already submitted', 'code', 'ALREADY_SUBMITTED');
  end;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_submission_id,
    'answer', v_norm_answer,
    'explanation', v_norm_explanation
  );
end;
$$;

-- 5. Update global transactional procedures to lock round1_state -> round2_state -> event_config

-- Admin Start Event
create or replace function public.admin_start_event_tx(
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
  v_cfg record;
  v_rounds jsonb;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_r1.id is not null and (v_r1.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_r1.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot start event while Round 1 is active or paused. Stop or reset the event first.', 'code', 'R1_ACTIVE');
  end if;

  if v_r2.id is not null and (v_r2.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED') or v_r2.is_paused) then
    return jsonb_build_object('ok', false, 'error', 'Cannot start event while Round 2 is active or paused. Stop or reset the event first.', 'code', 'R2_ACTIVE');
  end if;

  if exists (select 1 from public.submissions where round in (1, 2) limit 1) then
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

-- Admin Reset Gameplay
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
  v_cfg record;
  v_rounds jsonb;
  v_q1_count integer := 0;
  v_q2_count integer := 0;
begin
  -- Acquire locks FIRST before deleting records (round1_state -> round2_state -> event_config)
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
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

  return jsonb_build_object('ok', true, 'round1_state', to_jsonb(v_r1), 'round2_state', to_jsonb(v_r2));
end;
$$;

-- Admin Finalize Results
create or replace function public.admin_finalize_results_tx()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_cfg record;
  v_pending integer := 0;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
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

-- Admin Reopen Results
create or replace function public.admin_reopen_results_tx()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r1 record;
  v_r2 record;
  v_cfg record;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
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

-- Admin Stop Event
create or replace function public.admin_stop_event_tx(
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
  v_cfg record;
  v_rounds jsonb;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_r2 from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  if v_r1.id is null or v_r2.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  -- Advance any elapsed phases using authoritative database time
  if not v_r1.is_paused and v_r1.status in ('ACTIVE', 'COUNTDOWN') and v_r1.phase_ends_at is not null and p_now >= v_r1.phase_ends_at then
    perform public.advance_round1_state_tx(p_now);
    select * into v_r1 from public.round1_state where id = 'current' for update;
  end if;

  if not v_r2.is_paused and v_r2.status in ('ACTIVE', 'COUNTDOWN') and v_r2.phase_ends_at is not null and p_now >= v_r2.phase_ends_at then
    perform public.advance_round2_state_tx(p_now);
    select * into v_r2 from public.round2_state where id = 'current' for update;
  end if;

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
  returning * into v_r1;

  update public.round2_state
  set status = 'COMPLETED',
      phase = 'COMPLETED',
      is_paused = false,
      paused_remaining_ms = 0,
      pause_phase = null,
      current_question_id = null,
      version = version + 1,
      updated_at = p_now
  where id = 'current'
  returning * into v_r2;

  return jsonb_build_object('ok', true, 'round1_state', to_jsonb(v_r1), 'round2_state', to_jsonb(v_r2));
end;
$$;

-- Update submit_round1_answer to acquire share locks in consistent order
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
  v_r2 record;
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
  -- Read locks in global consistent order: round1_state -> round2_state -> event_config
  select * into v_state from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_event from public.event_config where id = 'event' for share;

  if v_state.id is null or v_state.is_paused or v_state.status <> 'ACTIVE' or v_state.phase <> 'QUESTION' then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently open', 'code', 'NOT_OPEN');
  end if;

  if v_event.id is not null and (v_event.rounds->'1'->>'state') <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 1 is not active', 'code', 'NOT_OPEN');
  end if;

  if v_event.id is not null and coalesce(v_event.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  if v_state.current_question_id is distinct from p_question_id then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently active', 'code', 'NOT_ACTIVE');
  end if;

  if v_state.phase_start_at is null or v_state.phase_ends_at is null or v_state.phase_start_at >= v_state.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Question timing is invalid or missing deadline', 'code', 'INVALID_TIMING');
  end if;

  if v_now < v_state.phase_start_at then
    return jsonb_build_object('ok', false, 'error', 'Question has not opened yet', 'code', 'NOT_OPEN_YET');
  end if;

  if v_now >= v_state.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Question deadline has expired', 'code', 'DEADLINE_EXPIRED');
  end if;

  if exists (select 1 from public.submissions where team_id = p_team_id and question_id = p_question_id) then
    return jsonb_build_object('ok', false, 'error', 'Already submitted', 'code', 'ALREADY_SUBMITTED');
  end if;

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

    if v_question.id is null then
      return jsonb_build_object('ok', false, 'error', 'Question not found', 'code', 'NOT_FOUND');
    end if;

    v_limit := coalesce(v_question.time_limit, 30);
    v_base_points := coalesce(v_question.base_points, 100);
    v_correct_answer := v_question.correct_answer;
  end if;

  v_speed_bonus := coalesce(v_state.speed_bonus_pct, 0.5);
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

  if v_correct then
    v_score := round(v_base_points * (1::numeric + (v_speed_bonus * v_speed_factor)), 0);
  else
    v_score := 0;
  end if;

  begin
    insert into public.submissions (
      team_id, question_id, round, answer, correct, time_taken, score, submitted_at
    ) values (
      p_team_id, p_question_id, 1, upper(trim(p_answer)), v_correct, v_time_taken, v_score, v_now
    ) returning id into v_submission_id;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'Already submitted', 'code', 'ALREADY_SUBMITTED');
  end;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_submission_id,
    'answer', upper(trim(p_answer))
  );
end;
$$;

-- Update submit_round3_trade_tx to acquire share locks in consistent order
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
  v_r1 record;
  v_r2 record;
  v_cfg record;
  v_session record;
  v_current_count integer;
  v_trade_number integer;
  v_trade record;
  v_now timestamptz := clock_timestamp();
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
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

-- Update admin_set_score_override_tx to acquire share locks in consistent order
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
  v_cfg record;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  if v_cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'Event config not found', 'code', 'CONFIG_MISSING');
  end if;

  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Reopen results before modifying scores.', 'code', 'FINALIZED');
  end if;

  insert into public.score_overrides (team_id, round, new_score, reason)
  values (p_team_id, p_round, p_new_score, p_reason)
  on conflict (team_id, round)
  do update set
    new_score = excluded.new_score,
    reason = excluded.reason;

  return jsonb_build_object('ok', true);
end;
$$;

-- Update admin_verify_trade_tx to acquire share locks in consistent order
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
  v_cfg record;
  v_trade record;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
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

-- Update admin_delete_trade_tx to acquire share locks in consistent order
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
  v_cfg record;
  v_trade record;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
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

-- Update admin_delete_team_tx to acquire share locks in consistent order
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
  v_cfg record;
  v_team record;
begin
  -- Consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_r2 from public.round2_state where id = 'current' for share;
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

-- Function execution grants
revoke all on function public.advance_round2_state_tx(timestamptz) from public;
revoke all on function public.advance_round2_state_tx(timestamptz) from anon;
revoke all on function public.advance_round2_state_tx(timestamptz) from authenticated;
grant execute on function public.advance_round2_state_tx(timestamptz) to service_role;

revoke all on function public.admin_set_round2_state_tx(text, timestamptz, jsonb, integer) from public;
revoke all on function public.admin_set_round2_state_tx(text, timestamptz, jsonb, integer) from anon;
revoke all on function public.admin_set_round2_state_tx(text, timestamptz, jsonb, integer) from authenticated;
grant execute on function public.admin_set_round2_state_tx(text, timestamptz, jsonb, integer) to service_role;

revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from public;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from anon;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from authenticated;
grant execute on function public.submit_round2_answer_tx(uuid, uuid, text, text) to service_role;

commit;

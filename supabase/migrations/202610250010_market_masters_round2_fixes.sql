-- =============================================================================
-- Migration: 202610250010_market_masters_round2_fixes.sql
-- Description:
-- 1. admin_set_round2_state_tx: Reject UPCOMING when running, paused, or completed/played.
--    Keep event_config and round2_state consistent without deleting submissions.
-- 2. advance_round2_state_tx: Avoid exclusive locks on routine unchanged status checks.
-- 3. submit_round2_answer_tx: Transactional authoritative enforcement of round, pause,
--    finalization, and deadline state.
-- 4. Sample Round 2 questions are not seeded automatically by this production migration;
--    they are maintained in an explicitly invoked local practice/test script.
-- =============================================================================

-- NOTE: Automatic seeding of sample questions has been removed from this production migration path.
-- Sample questions for local development and practice runs are maintained in an explicitly invoked script:
-- scripts/seed_round2_sample_questions.sql.
-- These sample questions are for local testing and practice runs only, and are NOT organizer-approved event questions.
-- NOTE: Removing this seed block does NOT undo or remove any rows already inserted in existing local
-- databases where migration 0010 was previously applied. Existing local practice rows are preserved.

-- 2. advance_round2_state_tx
-- Optimizes routine status checks by avoiding exclusive locks unless phase transition is required
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
  v_q_count integer;
  v_cur_phase text;
  v_cur_status text;
  v_cur_index integer;
  v_cur_qid uuid;
  v_cur_ends timestamptz;
  v_cur_start timestamptz;
  v_safety integer := 0;
  v_limit integer;
  v_closed_ids uuid[];
  v_item jsonb;
  v_q record;
begin
  -- Lightweight check without taking exclusive locks for routine reads
  select * into v_state from public.round2_state where id = 'current';

  if v_state.id is null then
    return jsonb_build_object('ok', false, 'error', 'Round 2 state row not found', 'code', 'STATE_NOT_FOUND');
  end if;

  if v_state.is_paused or v_state.status in ('IDLE', 'COMPLETED') or v_state.phase in ('WAITING', 'COMPLETED') then
    return to_jsonb(v_state);
  end if;

  if v_state.phase_ends_at is null or p_now < v_state.phase_ends_at then
    return to_jsonb(v_state);
  end if;

  -- Phase expired: acquire exclusive locks in consistent global order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for update;
  select * into v_state from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for update;

  -- Re-check with lock in case another transaction already advanced the phase
  if v_state.is_paused or v_state.status in ('IDLE', 'COMPLETED') or v_state.phase in ('WAITING', 'COMPLETED') or (v_state.phase_ends_at is not null and p_now < v_state.phase_ends_at) then
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

-- 3. admin_set_round2_state_tx
-- Rejects UPCOMING during running, paused, or completed/played runs with a clear instruction to use Reset Gameplay.
-- Keeps event_config and round2_state consistent without deleting submissions.
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
    -- Reject UPCOMING if Round 2 is running, paused, completed, or has closed questions/submissions
    if v_state.status in ('ACTIVE', 'COUNTDOWN', 'PAUSED', 'COMPLETED')
       or v_state.is_paused
       or v_state.phase = 'COMPLETED'
       or coalesce(array_length(v_state.closed_question_ids, 1), 0) > 0
       or exists (select 1 from public.submissions where round = 2 limit 1) then
      return jsonb_build_object(
        'ok', false,
        'error', 'Cannot return a running, paused, played or completed Round 2 run to UPCOMING. Perform an explicit Reset Gameplay first.',
        'code', 'ROUND_PLAYED'
      );
    end if;

    update public.round2_state
    set status = 'IDLE',
        phase = 'WAITING',
        current_question_index = 0,
        current_question_id = null,
        is_paused = false,
        paused_remaining_ms = 0,
        pause_phase = null,
        closed_question_ids = array[]::uuid[],
        frozen_questions = null,
        version = version + 1,
        updated_at = p_now
    where id = 'current'
    returning * into v_state;

    v_r2_round := jsonb_build_object('state', 'UPCOMING', 'started_at', null, 'ended_at', null);
  else
    return jsonb_build_object('ok', false, 'error', 'Invalid action', 'code', 'INVALID_ACTION');
  end if;

  v_rounds := jsonb_set(v_rounds, '{2}', v_r2_round);
  update public.event_config
  set rounds = v_rounds
  where id = 'event';

  return jsonb_build_object('ok', true, 'state', to_jsonb(v_state), 'rounds', v_rounds, 'round_value', v_r2_round);
end;
$$;

-- 4. submit_round2_answer_tx
-- Authoritatively enforces results_finalized, round state, pause, active question, and deadline inside the transaction
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
  v_cfg record;
  v_sub_id uuid;
  v_correct boolean;
  v_score integer;
  v_q record;
  v_clean_ans text;
  v_clean_expl text;
  v_correct_ans text;
  v_now timestamptz := clock_timestamp();
  v_item jsonb;
begin
  -- Global consistent lock order: round1_state -> round2_state -> event_config
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_state from public.round2_state where id = 'current' for update;
  select * into v_cfg from public.event_config where id = 'event' for share;

  -- 1. Authoritatively check finalization
  if v_cfg.results_finalized then
    return jsonb_build_object('ok', false, 'error', 'Results are finalized. Submissions are closed.', 'code', 'FINALIZED');
  end if;

  -- 2. Authoritatively check Round 2 active state and pause status
  if (v_cfg.rounds->'2'->>'state') = 'PAUSED' or v_state.is_paused or v_state.status = 'PAUSED' then
    return jsonb_build_object('ok', false, 'error', 'Round 2 is paused', 'code', 'ROUND_PAUSED');
  end if;

  if (v_cfg.rounds->'2'->>'state') != 'ACTIVE' or v_state.status != 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'Round 2 is not active', 'code', 'NOT_ACTIVE');
  end if;

  -- 3. Authoritatively check question phase
  if v_state.phase != 'QUESTION' then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently open', 'code', 'NOT_OPEN');
  end if;

  -- 4. Authoritatively check question ID
  if v_state.current_question_id != p_question_id then
    return jsonb_build_object('ok', false, 'error', 'Question is not currently active', 'code', 'QUESTION_MISMATCH');
  end if;

  -- 5. Authoritatively check deadline
  if v_state.phase_start_at is not null and v_now < v_state.phase_start_at then
    return jsonb_build_object('ok', false, 'error', 'Question has not opened yet', 'code', 'NOT_OPEN_YET');
  end if;

  if v_state.phase_ends_at is not null and v_now >= v_state.phase_ends_at then
    return jsonb_build_object('ok', false, 'error', 'Question deadline has expired', 'code', 'DEADLINE_EXPIRED');
  end if;

  -- 6. Answer validation: BUY, SELL, NO_TRADE only (no HOLD)
  v_clean_ans := upper(trim(coalesce(p_answer, '')));
  if v_clean_ans not in ('BUY', 'SELL', 'NO_TRADE') then
    return jsonb_build_object('ok', false, 'error', 'Invalid option. Must be BUY, SELL, or NO_TRADE.', 'code', 'INVALID_OPTION');
  end if;

  -- 7. Explanation validation: plain text, single line, 1..250 characters
  v_clean_expl := trim(coalesce(p_explanation, ''));
  if length(v_clean_expl) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Explanation is required', 'code', 'EXPLANATION_REQUIRED');
  end if;
  if length(v_clean_expl) > 250 then
    return jsonb_build_object('ok', false, 'error', 'Explanation must not exceed 250 characters', 'code', 'EXPLANATION_TOO_LONG');
  end if;
  if v_clean_expl ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'error', 'Explanation must be a single line', 'code', 'EXPLANATION_MULTILINE');
  end if;

  -- 8. Clean duplicate handling: return ALREADY_SUBMITTED without erroring out
  if exists (
    select 1 from public.submissions
    where team_id = p_team_id and question_id = p_question_id and round = 2
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'Your team has already submitted an answer for this question.',
      'code', 'ALREADY_SUBMITTED'
    );
  end if;

  -- 9. Determine correct answer
  v_correct_ans := null;
  if v_state.frozen_questions is not null then
    for v_item in select * from jsonb_array_elements(v_state.frozen_questions) loop
      if (v_item->>'id')::uuid = p_question_id then
        v_correct_ans := upper(trim(v_item->>'correct_answer'));
        exit;
      end if;
    end loop;
  end if;

  if v_correct_ans is null then
    select correct_answer into v_q from public.questions where id = p_question_id and round = 2;
    v_correct_ans := upper(trim(coalesce(v_q.correct_answer, '')));
  end if;

  -- 10. Fixed scoring: 1 point for correct BUY/SELL, 0 points for wrong, unanswered, or NO_TRADE. No speed bonus.
  if v_clean_ans in ('BUY', 'SELL') and v_clean_ans = v_correct_ans then
    v_correct := true;
    v_score := 1;
  else
    v_correct := false;
    v_score := 0;
  end if;

  -- 11. Insert submission
  insert into public.submissions (
    team_id,
    question_id,
    round,
    answer,
    explanation,
    correct,
    score,
    time_taken,
    submitted_at
  )
  values (
    p_team_id,
    p_question_id,
    2,
    v_clean_ans,
    v_clean_expl,
    v_correct,
    v_score,
    round(extract(epoch from (v_now - coalesce(v_state.phase_start_at, v_now)))::numeric, 2),
    v_now
  )
  returning id into v_sub_id;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub_id,
    'answer', v_clean_ans
  );
end;
$$;

-- Set permissions: service_role only
grant all on table public.round1_state to service_role;
grant all on table public.round2_state to service_role;

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

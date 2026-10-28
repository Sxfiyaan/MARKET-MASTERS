-- =============================================================================
-- Migration: 202610250011_market_masters_submit_r2_concurrency.sql
-- Description:
-- 1. Updates public.submit_round2_answer_tx:
--    - Replaces exclusive FOR UPDATE lock on round2_state with compatible FOR SHARE
--      locks across round1_state -> round2_state -> event_config in established lock order.
--      This eliminates unnecessary global submission serialization across different teams,
--      allowing concurrent submissions to proceed in parallel while preserving clean
--      coordination with transactions requiring exclusive locks (pause, reset, finalization).
--    - Enforces database uniqueness on public.submissions (team_id, question_id) and catches
--      unique_violation to return ALREADY_SUBMITTED cleanly for simultaneous teammate submissions.
--    - Restores strict fail-closed validation:
--      * Required event_config and round2_state records must exist (CONFIG_NOT_FOUND, STATE_NOT_FOUND).
--      * phase_start_at and phase_ends_at must both exist (INVALID_TIMING).
--      * phase_start_at must be strictly earlier than phase_ends_at (INVALID_TIMING).
--      * Enforces valid question window: reject before start (NOT_OPEN_YET) and after deadline (DEADLINE_EXPIRED).
--      * Uses null-safe active-question ID comparison (QUESTION_MISMATCH).
--      * Invalid state returns a controlled rejection, never accepting an answer.
-- =============================================================================

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
  -- 1. Shared gameplay-state locks preserving established global lock order:
  -- round1_state -> round2_state -> event_config.
  -- Uses FOR SHARE so concurrent submissions from different teams do NOT serialize
  -- on round2_state, while still cleanly coordinating with pause, reset, and finalization
  -- operations that acquire exclusive locks (FOR UPDATE).
  select * into v_r1 from public.round1_state where id = 'current' for share;
  select * into v_state from public.round2_state where id = 'current' for share;
  select * into v_cfg from public.event_config where id = 'event' for share;

  -- 2. Strict fail-closed validation: required records must exist
  if v_cfg.id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'Event configuration record not found',
      'code', 'CONFIG_NOT_FOUND'
    );
  end if;

  if v_state.id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'Round 2 state record not found',
      'code', 'STATE_NOT_FOUND'
    );
  end if;

  -- 3. Authoritatively check finalization
  if coalesce(v_cfg.results_finalized, false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'Results are finalized. Submissions are closed.',
      'code', 'FINALIZED'
    );
  end if;

  -- 4. Authoritatively check Round 2 active state and pause status
  if (v_cfg.rounds->'2'->>'state') = 'PAUSED' or coalesce(v_state.is_paused, false) or v_state.status = 'PAUSED' then
    return jsonb_build_object(
      'ok', false,
      'error', 'Round 2 is paused',
      'code', 'ROUND_PAUSED'
    );
  end if;

  if (v_cfg.rounds->'2'->>'state') is distinct from 'ACTIVE' or v_state.status is distinct from 'ACTIVE' then
    return jsonb_build_object(
      'ok', false,
      'error', 'Round 2 is not active',
      'code', 'NOT_ACTIVE'
    );
  end if;

  -- 5. Authoritatively check question phase
  if v_state.phase is distinct from 'QUESTION' then
    return jsonb_build_object(
      'ok', false,
      'error', 'Question is not currently open',
      'code', 'NOT_OPEN'
    );
  end if;

  -- 6. Null-safe active-question ID comparison
  if p_question_id is null or v_state.current_question_id is null or v_state.current_question_id is distinct from p_question_id then
    return jsonb_build_object(
      'ok', false,
      'error', 'Question is not currently active',
      'code', 'QUESTION_MISMATCH'
    );
  end if;

  -- 7. Strict timing window validation:
  -- Both phase_start_at and phase_ends_at must exist, and phase_start_at must be strictly earlier than phase_ends_at.
  if v_state.phase_start_at is null or v_state.phase_ends_at is null or v_state.phase_start_at >= v_state.phase_ends_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'Invalid question phase timing window',
      'code', 'INVALID_TIMING'
    );
  end if;

  -- Enforce valid question window against server clock
  if v_now < v_state.phase_start_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'Question has not opened yet',
      'code', 'NOT_OPEN_YET'
    );
  end if;

  if v_now >= v_state.phase_ends_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'Question deadline has expired',
      'code', 'DEADLINE_EXPIRED'
    );
  end if;

  -- 8. Answer validation: BUY, SELL, NO_TRADE only (no HOLD)
  v_clean_ans := upper(trim(coalesce(p_answer, '')));
  if v_clean_ans not in ('BUY', 'SELL', 'NO_TRADE') then
    return jsonb_build_object(
      'ok', false,
      'error', 'Invalid option. Must be BUY, SELL, or NO_TRADE.',
      'code', 'INVALID_OPTION'
    );
  end if;

  -- 9. Explanation validation: plain text, single line, 1..250 characters
  v_clean_expl := trim(coalesce(p_explanation, ''));
  if length(v_clean_expl) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'Explanation is required',
      'code', 'EXPLANATION_REQUIRED'
    );
  end if;
  if length(v_clean_expl) > 250 then
    return jsonb_build_object(
      'ok', false,
      'error', 'Explanation must not exceed 250 characters',
      'code', 'EXPLANATION_TOO_LONG'
    );
  end if;
  if v_clean_expl ~ '[\r\n]' then
    return jsonb_build_object(
      'ok', false,
      'error', 'Explanation must be a single line',
      'code', 'EXPLANATION_MULTILINE'
    );
  end if;

  -- 10. Clean duplicate handling: fast path check
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

  -- 11. Determine correct answer
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

  -- 12. Fixed scoring: 1 point for correct BUY/SELL, 0 points for wrong, unanswered, or NO_TRADE. No speed bonus.
  if v_clean_ans in ('BUY', 'SELL') and v_clean_ans = v_correct_ans then
    v_correct := true;
    v_score := 1;
  else
    v_correct := false;
    v_score := 0;
  end if;

  -- 13. Insert submission atomically: catch unique_violation cleanly for concurrent teammate submissions
  begin
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
      round(extract(epoch from (v_now - v_state.phase_start_at))::numeric, 2),
      v_now
    )
    returning id into v_sub_id;
  exception when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'error', 'Your team has already submitted an answer for this question.',
      'code', 'ALREADY_SUBMITTED'
    );
  end;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub_id,
    'answer', v_clean_ans
  );
end;
$$;

-- Permissions: service_role only
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from public;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from anon;
revoke all on function public.submit_round2_answer_tx(uuid, uuid, text, text) from authenticated;
grant execute on function public.submit_round2_answer_tx(uuid, uuid, text, text) to service_role;

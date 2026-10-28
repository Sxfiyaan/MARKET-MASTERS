-- =============================================================================
-- Script: scripts/seed_round2_sample_questions.sql
-- Description:
-- Sample Round 2 questions for local testing, practice, and rehearsal runs.
--
-- IMPORTANT NOTICE:
-- These are sample practice questions intended solely for local testing, rehearsal,
-- and developer verification.
-- They are NOT organizer-approved event questions. Official, organizer-approved
-- competition questions and charts will be loaded authoritatively by event staff.
--
-- Explicitly invoked by developers/admins when practice data is desired.
-- Idempotent: safe to run multiple times without duplicating questions.
-- =============================================================================

INSERT INTO public.questions (
  id,
  round,
  question_order,
  text,
  options,
  correct_answer,
  base_points,
  time_limit,
  asset,
  timeframe
)
VALUES
  ('20000000-0000-0000-0000-000000000001'::uuid, 2, 0, 'Chart 1: NIFTY 50 Daily Breakout', '["BUY", "SELL", "NO_TRADE"]'::jsonb, 'BUY', 1, 120, 'NIFTY50', '1D'),
  ('20000000-0000-0000-0000-000000000002'::uuid, 2, 1, 'Chart 2: RELIANCE Bearish Engulfing', '["BUY", "SELL", "NO_TRADE"]'::jsonb, 'SELL', 1, 120, 'RELIANCE', '4H'),
  ('20000000-0000-0000-0000-000000000003'::uuid, 2, 2, 'Chart 3: INFY Sideways Consolidation', '["BUY", "SELL", "NO_TRADE"]'::jsonb, 'BUY', 1, 120, 'INFY', '1H'),
  ('20000000-0000-0000-0000-000000000004'::uuid, 2, 3, 'Chart 4: HDFCBANK Double Top', '["BUY", "SELL", "NO_TRADE"]'::jsonb, 'SELL', 1, 120, 'HDFCBANK', '15M'),
  ('20000000-0000-0000-0000-000000000005'::uuid, 2, 4, 'Chart 5: TATASTEEL Fakeout', '["BUY", "SELL", "NO_TRADE"]'::jsonb, 'BUY', 1, 120, 'TATASTEEL', '1D')
ON CONFLICT (id) DO UPDATE SET
  round = EXCLUDED.round,
  question_order = EXCLUDED.question_order,
  text = EXCLUDED.text,
  options = EXCLUDED.options,
  correct_answer = EXCLUDED.correct_answer,
  base_points = EXCLUDED.base_points,
  time_limit = EXCLUDED.time_limit,
  asset = EXCLUDED.asset,
  timeframe = EXCLUDED.timeframe;

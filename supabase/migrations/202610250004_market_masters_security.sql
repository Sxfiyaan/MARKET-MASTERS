create index if not exists teams_owner_user_idx on public.teams (owner_user_id);
create index if not exists profiles_team_idx on public.profiles (team_id);
create index if not exists submissions_question_idx on public.submissions (question_id);
create index if not exists audit_user_idx on public.audit_logs (user_id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'teams', 'profiles', 'event_config', 'questions', 'submissions',
    'round3_sessions', 'trades', 'score_overrides', 'leaderboard_snapshot',
    'announcements', 'audit_logs'
  ] loop
    execute format(
      'create policy deny_public_access on public.%I for all to anon, authenticated using (false) with check (false)',
      table_name
    );
  end loop;
end $$;

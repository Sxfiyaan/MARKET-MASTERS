-- Migration 202610250014: Restrict public.leaderboard_snapshot SELECT to when event_config.leaderboard_visible is true
-- Replaces unconditional SELECT policy with a visibility-guarded check for anon and authenticated roles.
-- Service-role bypasses RLS and maintains full direct access.

drop policy if exists public_leaderboard_read on public.leaderboard_snapshot;

create policy public_leaderboard_read
  on public.leaderboard_snapshot
  for select
  to anon, authenticated
  using (
    coalesce(
      (select leaderboard_visible from public.event_config where id = 'event'),
      false
    ) = true
  );

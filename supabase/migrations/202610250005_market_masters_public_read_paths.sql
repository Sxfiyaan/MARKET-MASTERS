grant select on public.event_config to anon, authenticated;
grant select on public.leaderboard_snapshot to anon, authenticated;

drop policy if exists public_event_config_read on public.event_config;
create policy public_event_config_read
  on public.event_config
  for select
  to anon, authenticated
  using (id = 'event');

drop policy if exists public_leaderboard_read on public.leaderboard_snapshot;
create policy public_leaderboard_read
  on public.leaderboard_snapshot
  for select
  to anon, authenticated
  using (true);

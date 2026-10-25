create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  team_name text not null unique,
  leader_name text not null,
  leader_email text not null,
  leader_phone text not null,
  college text not null,
  members jsonb not null default '[]'::jsonb,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  role text not null default 'team' check (role in ('team', 'admin')),
  team_id uuid references public.teams(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.event_config (
  id text primary key,
  event_name text not null,
  team_size integer not null default 4,
  registration_open boolean not null default true,
  round1_weight numeric not null default 30,
  round2_weight numeric not null default 30,
  round3_weight numeric not null default 40,
  round3_duration_minutes integer not null default 60,
  max_trades integer not null default 2,
  starting_capital numeric not null default 100000,
  max_risk_per_trade numeric not null default 2,
  performance_weight numeric not null default 60,
  risk_mgmt_weight numeric not null default 40,
  leaderboard_visible boolean not null default true,
  trade_proof_required boolean not null default false,
  speed_bonus_pct numeric not null default 0.5,
  rounds jsonb not null default '{"1":{"state":"UPCOMING","started_at":null,"ended_at":null},"2":{"state":"UPCOMING","started_at":null,"ended_at":null},"3":{"state":"UPCOMING","started_at":null,"ended_at":null}}'::jsonb
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  round integer not null check (round in (1, 2)),
  text text,
  options jsonb not null default '[]'::jsonb,
  correct_answer text not null,
  base_points integer not null default 100,
  time_limit integer not null default 30,
  asset text,
  timeframe text,
  chart_image_url text,
  question_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  round integer not null check (round in (1, 2)),
  answer text not null,
  correct boolean not null,
  time_taken numeric not null check (time_taken >= 0),
  score numeric not null default 0,
  submitted_at timestamptz not null default now(),
  unique (team_id, question_id)
);

create table if not exists public.round3_sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null unique references public.teams(id) on delete cascade,
  started_at timestamptz not null,
  ends_at timestamptz not null,
  closed boolean not null default false
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  trade_number integer not null,
  asset text not null,
  account_size numeric not null check (account_size > 0),
  risk_per_trade numeric not null check (risk_per_trade >= 0),
  result_type text not null check (result_type in ('PROFIT', 'LOSS')),
  profit numeric not null default 0,
  loss numeric not null default 0,
  pl_percentage numeric not null,
  verification_status text not null default 'PENDING' check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  admin_notes text,
  proof_url text,
  submitted_at timestamptz not null default now(),
  unique (team_id, trade_number)
);

create table if not exists public.score_overrides (
  team_id uuid not null references public.teams(id) on delete cascade,
  round integer not null check (round in (1, 2, 3)),
  new_score numeric not null,
  reason text not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, round)
);

create table if not exists public.leaderboard_snapshot (
  team_id uuid primary key references public.teams(id) on delete cascade,
  team_name text not null,
  college text not null,
  round1 numeric not null default 0,
  round2 numeric not null default 0,
  round3 numeric not null default 0,
  performance_score numeric not null default 0,
  risk_score numeric not null default 0,
  total_pl_pct numeric not null default 0,
  total numeric not null default 0,
  rank integer not null,
  rank_change text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  role text,
  action text not null,
  details jsonb not null default '{}'::jsonb
);

create index if not exists questions_round_order_idx on public.questions (round, question_order);
create index if not exists submissions_team_round_idx on public.submissions (team_id, round);
create index if not exists trades_team_number_idx on public.trades (team_id, trade_number);
create index if not exists trades_status_idx on public.trades (verification_status);
create index if not exists audit_timestamp_idx on public.audit_logs (timestamp desc);
create index if not exists announcements_created_idx on public.announcements (created_at desc);

insert into public.event_config (id, event_name)
values ('event', 'Market Masters: The Trading Floor')
on conflict (id) do nothing;

alter table public.teams enable row level security;
alter table public.profiles enable row level security;
alter table public.event_config enable row level security;
alter table public.questions enable row level security;
alter table public.submissions enable row level security;
alter table public.round3_sessions enable row level security;
alter table public.trades enable row level security;
alter table public.score_overrides enable row level security;
alter table public.leaderboard_snapshot enable row level security;
alter table public.announcements enable row level security;
alter table public.audit_logs enable row level security;

revoke all on table public.teams, public.profiles, public.event_config, public.questions,
  public.submissions, public.round3_sessions, public.trades, public.score_overrides,
  public.leaderboard_snapshot, public.announcements, public.audit_logs from anon, authenticated;

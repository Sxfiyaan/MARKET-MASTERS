create table if not exists public.app_documents (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists app_documents_collection_idx
  on public.app_documents (collection);

create index if not exists app_documents_data_gin_idx
  on public.app_documents using gin (data);

create unique index if not exists users_email_unique_idx
  on public.app_documents ((data->>'email'))
  where collection = 'users';

create unique index if not exists teams_name_unique_idx
  on public.app_documents ((data->>'team_name'))
  where collection = 'teams';

create unique index if not exists submissions_team_question_unique_idx
  on public.app_documents ((data->>'team_id'), (data->>'question_id'))
  where collection = 'submissions';

create unique index if not exists trades_team_number_unique_idx
  on public.app_documents ((data->>'team_id'), ((data->>'trade_number')::integer))
  where collection = 'trades';

create index if not exists documents_round_order_idx
  on public.app_documents (
    collection,
    ((data->>'round')::integer),
    ((data->>'order')::integer)
  )
  where collection = 'questions';

alter table public.app_documents enable row level security;

revoke all on table public.app_documents from anon, authenticated;

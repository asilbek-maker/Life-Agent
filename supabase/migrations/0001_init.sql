-- Life Agent schema (M1). One user; every row belongs to auth.uid().
-- Ids are made on the phone (UUIDs), so offline saves can be retried safely.
-- deleted_at is a soft delete, so sync and undo work.

create table public.profile (
  user_id uuid primary key references auth.users on delete cascade default auth.uid(),
  timezone text not null default 'UTC',
  monthly_budget_usd numeric(8,2) not null default 5.00,
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  area text not null check (area in ('gym','study','work','health','mood','other')),
  date date not null,
  title text not null,
  minutes int check (minutes >= 0),
  details text not null default '',
  data jsonb not null default '{}',
  source text not null default 'app' check (source in ('app','quicklog','agent','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index entries_user_date on public.entries (user_id, date desc) where deleted_at is null;
create index entries_user_area on public.entries (user_id, area, date desc) where deleted_at is null;

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  area text not null default 'other',
  text text not null,
  deadline date,
  target_value numeric,
  current_value numeric,
  unit text,
  done boolean not null default false,
  completed_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index goals_user on public.goals (user_id) where deleted_at is null;

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null,
  area text not null default 'other',
  time_of_day time not null,
  repeat text not null check (repeat in ('once','daily','weekdays','weekly')),
  start_date date not null,
  timezone text not null default 'UTC',
  next_due_at timestamptz,
  last_sent_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index reminders_user on public.reminders (user_id) where deleted_at is null;
create index reminders_due on public.reminders (next_due_at) where active and deleted_at is null;

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  settings jsonb not null default '{}',
  days jsonb not null,
  next_day int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index one_active_plan on public.plans (user_id) where active and deleted_at is null;

create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  area text not null,
  name text not null,
  url text not null check (url ~ '^https?://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index links_user on public.links (user_id) where deleted_at is null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_user_time on public.messages (user_id, created_at desc);

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  message_id uuid references public.messages on delete set null,
  tool text not null,
  table_name text not null check (table_name in ('entries','goals','reminders','plans')),
  row_id uuid not null,
  op text not null check (op in ('insert','update','delete')),
  before jsonb,
  after jsonb,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_actions_user_time on public.agent_actions (user_id, created_at desc);
create index agent_actions_message on public.agent_actions (message_id);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  failed_count int not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

create table public.usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);
create index usage_user_time on public.usage_log (user_id, created_at desc);

-- updated_at trigger
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['profile','entries','goals','reminders','plans','links'] loop
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- Row Level Security. Only the signed-in owner can see or change a row.
-- The public (anon) key has no policies, so it can read nothing.
do $$ declare t text; begin
  foreach t in array array['profile','entries','goals','reminders','plans','links','messages','agent_actions','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- usage_log: the owner can read it; only the Edge Function (service role) writes it.
alter table public.usage_log enable row level security;
create policy own_rows_read on public.usage_log for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.usage_log from anon;
revoke insert, update, delete on public.usage_log from authenticated;

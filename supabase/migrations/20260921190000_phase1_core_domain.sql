-- Phase 1: additive core scheduling foundation.
-- Safe to run more than once. This migration does not delete or rewrite legacy data.

create extension if not exists pgcrypto;

-- Existing tables are retained. These columns normalize the current structures
-- without renaming or dropping fields that may already contain user data.
alter table if exists public.profiles add column if not exists locale text not null default 'ar';

-- The existing canonical columns are retained: name=display_name,
-- photo=avatar_url, and slug=booking_slug. No duplicate profile columns are added.
alter table if exists public.meeting_types add column if not exists slug text;
alter table if exists public.meeting_types add column if not exists description text;
alter table if exists public.meeting_types add column if not exists description_ar text;
alter table if exists public.meeting_types add column if not exists buffer_before_minutes integer not null default 0;
alter table if exists public.meeting_types add column if not exists buffer_after_minutes integer not null default 0;
alter table if exists public.meeting_types add column if not exists minimum_notice_minutes integer;
alter table if exists public.meeting_types add column if not exists booking_horizon_days integer;
alter table if exists public.meeting_types add column if not exists updated_at timestamptz not null default now();

-- The remote baseline already has the duration constraint. Add only the new
-- buffer constraint when it does not exist; never drop an existing constraint.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meeting_types_buffers_check') then
    alter table public.meeting_types add constraint meeting_types_buffers_check
      check (buffer_before_minutes >= 0 and buffer_after_minutes >= 0);
  end if;
end $$;

create unique index if not exists meeting_types_owner_slug_unique_idx
  on public.meeting_types (owner_id, slug)
  where slug is not null;

-- Structured weekly availability. Multiple intervals per weekday are supported.
create table if not exists public.availability_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Default schedule',
  timezone text not null default 'Asia/Riyadh',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists availability_schedules_default_owner_idx
  on public.availability_schedules(owner_id)
  where is_default;

create table if not exists public.availability_intervals (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.availability_schedules(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_local time not null,
  end_local time not null,
  created_at timestamptz not null default now(),
  check (end_local > start_local)
);

create index if not exists availability_intervals_schedule_day_idx
  on public.availability_intervals(schedule_id, weekday, start_local);

create table if not exists public.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  schedule_id uuid references public.availability_schedules(id) on delete cascade,
  override_date date not null,
  is_available boolean not null default false,
  start_local time,
  end_local time,
  reason text,
  created_at timestamptz not null default now(),
  check ((is_available and start_local is not null and end_local is not null and end_local > start_local)
      or (not is_available and start_local is null and end_local is null))
);

create unique index if not exists availability_overrides_owner_date_idx
  on public.availability_overrides(owner_id, override_date);

-- Calendar metadata is deliberately separate from secrets. Provider tokens stay
-- in trusted server-side storage until a dedicated secret-management decision.
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft','apple')),
  provider_account_id text,
  selected_calendar_id text,
  authorization_status text not null default 'pending'
    check (authorization_status in ('pending','authorized','revoked','error')),
  granted_scopes text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, provider, provider_account_id)
);

create index if not exists calendar_connections_owner_idx
  on public.calendar_connections(owner_id, provider, authorization_status);

-- Existing bookings already use owner_id and timestamptz. These additive fields
-- make the intended canonical vocabulary explicit without destroying data.
alter table if exists public.bookings add column if not exists guest_phone text;
alter table if exists public.bookings add column if not exists external_provider text;
alter table if exists public.bookings add column if not exists external_event_id text;
alter table if exists public.bookings add column if not exists meeting_url text;
alter table if exists public.bookings add column if not exists cancelled_at timestamptz;
alter table if exists public.bookings add column if not exists rescheduled_from_id uuid references public.bookings(id);
alter table if exists public.bookings add column if not exists updated_at timestamptz not null default now();
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_end_after_start_check') then
    alter table public.bookings add constraint bookings_end_after_start_check check (ends_at > starts_at);
  end if;
end $$;

create index if not exists bookings_owner_status_start_idx
  on public.bookings(owner_id, status, starts_at);

-- RLS for the new canonical tables. The API uses a trusted server boundary for
-- public booking creation; no anonymous table-wide read access is granted.
alter table public.availability_schedules enable row level security;
alter table public.availability_intervals enable row level security;
alter table public.availability_overrides enable row level security;
alter table public.calendar_connections enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='availability_schedules' and policyname='owners manage availability schedules') then
    create policy "owners manage availability schedules" on public.availability_schedules
      for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='availability_intervals' and policyname='owners manage availability intervals') then
    create policy "owners manage availability intervals" on public.availability_intervals
      for all using (exists (select 1 from public.availability_schedules s where s.id = schedule_id and s.owner_id = auth.uid()))
      with check (exists (select 1 from public.availability_schedules s where s.id = schedule_id and s.owner_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='availability_overrides' and policyname='owners manage availability overrides') then
    create policy "owners manage availability overrides" on public.availability_overrides
      for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calendar_connections' and policyname='owners manage calendar connections') then
    create policy "owners manage calendar connections" on public.calendar_connections
      for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
end $$;

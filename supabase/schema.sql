-- CalPro / Mawaeedy initial Supabase schema
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  photo text,
  bio text,
  job_title text,
  timezone text not null default 'Asia/Riyadh',
  slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.meeting_types (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  mode text not null default 'Google Meet',
  color text not null default '#2166f3',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  day_of_week smallint check (day_of_week between 0 and 6),
  start_time time,
  end_time time,
  label text,
  enabled boolean not null default true
);

create table if not exists public.booking_rules (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  minimum_notice_minutes integer not null default 60 check (minimum_notice_minutes >= 0),
  maximum_days_ahead integer not null default 60 check (maximum_days_ahead > 0),
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  meeting_type_id uuid references public.meeting_types(id) on delete set null,
  guest_name text not null,
  guest_email text not null,
  guest_timezone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','rescheduled')),
  manage_token_hash text,
  google_event_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft','apple','zoom','teams')),
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(owner_id, provider)
);

create table if not exists public.notification_preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  email boolean not null default true,
  whatsapp boolean not null default false,
  sms boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade,
  channel text not null default 'in-app',
  notification_type text not null,
  message text not null,
  status text not null default 'unread',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.meeting_types enable row level security;
alter table public.availability_rules enable row level security;
alter table public.booking_rules enable row level security;
alter table public.bookings enable row level security;
alter table public.integrations enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;

create policy "profiles public read by slug" on public.profiles for select using (true);
create policy "profiles owner write" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "owners manage meeting types" on public.meeting_types for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners manage availability" on public.availability_rules for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners manage booking rules" on public.booking_rules for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners read bookings" on public.bookings for select using (auth.uid() = owner_id);
-- Public bookings should be created by a server-side endpoint using the service role,
-- after validating availability. Do not allow anonymous direct inserts here.
create policy "owners manage integrations" on public.integrations for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners manage notification preferences" on public.notification_preferences for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners read notifications" on public.notifications for select using (auth.uid() = owner_id);

create index if not exists bookings_owner_start_idx on public.bookings(owner_id, starts_at);
create index if not exists meeting_types_owner_idx on public.meeting_types(owner_id, active);
create index if not exists profiles_slug_idx on public.profiles(slug);

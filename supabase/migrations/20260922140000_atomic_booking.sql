-- Phase 1 Cutover C2: authoritative, race-safe booking creation.
--
-- Preconditions:
--   * The remote booking audit has confirmed that public.bookings is empty.
--   * The Phase 1 meeting type, profile, schedule, interval, and override
--     tables already exist.
--   * The server supplies a timezone-resolved offset for the requested host
--     local wall-clock time. This function verifies the offset; it does not
--     blindly append Z to a local time.

create extension if not exists btree_gist;

do $$
begin
  if exists (select 1 from public.bookings limit 1) then
    raise exception using
      errcode = 'P0001',
      message = 'C2 migration requires the remote bookings table to be empty; run the booking audit first.';
  end if;
end
$$;

alter table public.bookings
  add column if not exists occupied_starts_at timestamptz,
  add column if not exists occupied_ends_at timestamptz,
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists cancellation_reason text;

-- The verified empty table lets the canonical contract become NOT NULL
-- without inventing provenance for legacy booking rows.
alter table public.bookings
  alter column occupied_starts_at set not null,
  alter column occupied_ends_at set not null,
  alter column idempotency_key set not null,
  alter column request_fingerprint set not null;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table public.bookings drop constraint bookings_status_check;
  end if;
  alter table public.bookings add constraint bookings_status_check
    check (status in ('confirmed', 'cancelled'));
exception when duplicate_object then
  null;
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_actual_range_check') then
    alter table public.bookings add constraint bookings_actual_range_check
      check (ends_at > starts_at);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_occupied_range_check') then
    alter table public.bookings add constraint bookings_occupied_range_check
      check (occupied_ends_at > occupied_starts_at);
  end if;
end
$$;

create unique index if not exists bookings_owner_idempotency_key_idx
  on public.bookings(owner_id, idempotency_key);

create table if not exists public.booking_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event_type text not null check (event_type in ('created', 'rescheduled', 'cancelled')),
  old_starts_at timestamptz,
  old_ends_at timestamptz,
  new_starts_at timestamptz,
  new_ends_at timestamptz,
  actor_type text not null check (actor_type in ('guest', 'host', 'system')),
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists booking_history_booking_created_idx
  on public.booking_history(booking_id, created_at);

alter table public.bookings
  add constraint bookings_no_active_overlap
  exclude using gist (
    owner_id with =,
    tstzrange(occupied_starts_at, occupied_ends_at, '[)') with &&
  )
  where (status = 'confirmed');

create or replace function public.create_booking_atomically(
  p_profile_slug text,
  p_meeting_type_id uuid,
  p_requested_local timestamp without time zone,
  p_requested_offset_minutes integer,
  p_guest_timezone text,
  p_guest_name text,
  p_guest_email text,
  p_guest_phone text,
  p_notes text,
  p_idempotency_key text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_host_timezone text;
  v_schedule_id uuid;
  v_duration integer;
  v_before integer;
  v_after integer;
  v_minimum_notice integer;
  v_booking_horizon integer;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_occupied_starts_at timestamptz;
  v_occupied_ends_at timestamptz;
  v_local_end timestamp without time zone;
  v_weekday integer;
  v_override public.availability_overrides;
  v_existing public.bookings;
  v_booking public.bookings;
  v_fingerprint text;
begin
  if nullif(trim(p_profile_slug), '') is null
     or p_meeting_type_id is null
     or p_requested_local is null
     or nullif(trim(p_guest_name), '') is null
     or nullif(trim(p_guest_email), '') is null
     or nullif(trim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if lower(trim(p_guest_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  select p.id, p.timezone
    into v_owner_id, v_host_timezone
  from public.profiles p
  where p.slug = lower(trim(p_profile_slug))
  for share;

  if v_owner_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  select s.id, s.timezone
    into v_schedule_id, v_host_timezone
  from public.availability_schedules s
  where s.owner_id = v_owner_id
    and s.is_default = true
  for share;

  if v_schedule_id is null then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;

  if not exists (select 1 from pg_timezone_names where name = v_host_timezone)
     or not exists (select 1 from pg_timezone_names where name = p_guest_timezone) then
    raise exception using errcode = 'P0001', message = 'INVALID_TIMEZONE';
  end if;

  if p_requested_offset_minutes is null
     or p_requested_offset_minutes not between -840 and 840 then
    raise exception using errcode = 'P0001', message = 'INVALID_LOCAL_TIME';
  end if;

  -- The trusted server resolves DST ambiguity and supplies the offset. The
  -- RPC derives the UTC instant and rejects a nonexistent/mismatched local
  -- time through the round trip below.
  v_starts_at := (
    p_requested_local - make_interval(mins => p_requested_offset_minutes)
  ) at time zone 'UTC';

  if (v_starts_at at time zone v_host_timezone) <> p_requested_local then
    raise exception using errcode = 'P0001', message = 'INVALID_LOCAL_TIME';
  end if;

  select
    mt.duration_minutes,
    mt.buffer_before_minutes,
    mt.buffer_after_minutes,
    coalesce(mt.minimum_notice_minutes, br.minimum_notice_minutes, 0),
    coalesce(mt.booking_horizon_days, br.maximum_days_ahead, 60)
    into v_duration, v_before, v_after, v_minimum_notice, v_booking_horizon
  from public.meeting_types mt
  left join public.booking_rules br on br.owner_id = mt.owner_id
  where mt.id = p_meeting_type_id
    and mt.owner_id = v_owner_id
    and mt.active = true
  for share of mt;

  if v_duration is null then
    raise exception using errcode = 'P0001', message = 'INACTIVE_MEETING_TYPE';
  end if;

  v_ends_at := v_starts_at + make_interval(mins => v_duration);
  v_local_end := p_requested_local + make_interval(mins => v_duration);

  if v_local_end::date <> p_requested_local::date then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;

  if v_starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'INVALID_LOCAL_TIME';
  end if;
  if v_starts_at <= now() + make_interval(mins => v_minimum_notice) then
    raise exception using errcode = 'P0001', message = 'TOO_SOON';
  end if;
  if v_starts_at >= now() + make_interval(days => v_booking_horizon) then
    raise exception using errcode = 'P0001', message = 'BEYOND_BOOKING_HORIZON';
  end if;

  v_weekday := extract(dow from p_requested_local)::integer;

  select *
    into v_override
  from public.availability_overrides o
  where o.owner_id = v_owner_id
    and o.override_date = p_requested_local::date
    and (o.schedule_id is null or o.schedule_id = v_schedule_id)
  for share;

  if found and not v_override.is_available then
    raise exception using errcode = 'P0001', message = 'DATE_UNAVAILABLE';
  elsif found and (
    p_requested_local::time < v_override.start_local
    or v_local_end::time > v_override.end_local
  ) then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  elsif not found and not exists (
    select 1
    from public.availability_intervals i
    where i.schedule_id = v_schedule_id
      and i.weekday = v_weekday
      and p_requested_local::time >= i.start_local
      and v_local_end::time <= i.end_local
  ) then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;

  v_occupied_starts_at := v_starts_at - make_interval(mins => v_before);
  v_occupied_ends_at := v_ends_at + make_interval(mins => v_after);

  v_fingerprint := encode(extensions.digest(concat_ws(
    '|',
    lower(trim(p_profile_slug)),
    p_meeting_type_id::text,
    p_requested_local::text,
    p_requested_offset_minutes::text,
    lower(trim(p_guest_email)),
    coalesce(p_guest_timezone, ''),
    coalesce(p_guest_phone, ''),
    coalesce(p_notes, '')
  ), 'sha256'), 'hex');

  select *
    into v_existing
  from public.bookings b
  where b.owner_id = v_owner_id
    and b.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing;
  end if;

  begin
    insert into public.bookings (
      owner_id,
      meeting_type_id,
      guest_name,
      guest_email,
      guest_phone,
      guest_timezone,
      starts_at,
      ends_at,
      occupied_starts_at,
      occupied_ends_at,
      notes,
      status,
      idempotency_key,
      request_fingerprint,
      created_at,
      updated_at
    ) values (
      v_owner_id,
      p_meeting_type_id,
      trim(p_guest_name),
      lower(trim(p_guest_email)),
      nullif(trim(p_guest_phone), ''),
      p_guest_timezone,
      v_starts_at,
      v_ends_at,
      v_occupied_starts_at,
      v_occupied_ends_at,
      nullif(trim(p_notes), ''),
      'confirmed',
      p_idempotency_key,
      v_fingerprint,
      now(),
      now()
    ) returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SLOT_TAKEN';
    when unique_violation then
      select *
        into v_existing
      from public.bookings b
      where b.owner_id = v_owner_id
        and b.idempotency_key = p_idempotency_key
      for update;
      if v_existing.id is null then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
      end if;
      if v_existing.request_fingerprint <> v_fingerprint then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
      end if;
      return v_existing;
  end;

  insert into public.booking_history (
    booking_id,
    event_type,
    new_starts_at,
    new_ends_at,
    actor_type
  ) values (
    v_booking.id,
    'created',
    v_booking.starts_at,
    v_booking.ends_at,
    'guest'
  );

  return v_booking;
end;
$$;

alter table public.booking_history enable row level security;

revoke all on public.booking_history from public;
revoke all on public.booking_history from anon;
revoke all on public.booking_history from authenticated;
grant all on public.booking_history to service_role;

revoke insert, update, delete on public.bookings from anon, authenticated;

revoke all on function public.create_booking_atomically(
  text, uuid, timestamp without time zone, integer, text, text, text, text, text, text
) from public;
revoke all on function public.create_booking_atomically(
  text, uuid, timestamp without time zone, integer, text, text, text, text, text, text
) from anon;
revoke all on function public.create_booking_atomically(
  text, uuid, timestamp without time zone, integer, text, text, text, text, text, text
) from authenticated;
grant execute on function public.create_booking_atomically(
  text, uuid, timestamp without time zone, integer, text, text, text, text, text, text
) to service_role;

comment on function public.create_booking_atomically(
  text, uuid, timestamp without time zone, integer, text, text, text, text, text, text
) is 'Server-only atomic booking creation. The server resolves DST offsets; PostgreSQL derives UTC and enforces internal conflicts.';

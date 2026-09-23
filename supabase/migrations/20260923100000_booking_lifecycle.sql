-- C3: token-aware booking lifecycle and serialized availability overrides.
-- Applied C2 migrations remain immutable. All RPCs are trusted server-only
-- SECURITY INVOKER functions called with the Supabase service-role key.

alter table public.booking_history
  add column operation_key text,
  add column request_fingerprint text;

alter table public.booking_history
  add constraint booking_history_operation_pair_check
    check ((operation_key is null) = (request_fingerprint is null)),
  add constraint booking_history_operation_key_check
    check (operation_key is null or operation_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  add constraint booking_history_operation_fingerprint_check
    check (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$');

create unique index bookings_manage_token_hash_unique_idx
  on public.bookings (manage_token_hash)
  where manage_token_hash is not null;

create unique index booking_history_booking_operation_key_idx
  on public.booking_history (booking_id, operation_key)
  where operation_key is not null;

create or replace function public.create_booking_with_management_atomically(
  p_profile_slug text,
  p_meeting_type_id uuid,
  p_requested_local timestamp without time zone,
  p_requested_offset_minutes integer,
  p_guest_timezone text,
  p_guest_name text,
  p_guest_email text,
  p_guest_phone text,
  p_notes text,
  p_idempotency_key text,
  p_manage_token_hash text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
  v_stored_hash text;
begin
  if p_manage_token_hash is null or p_manage_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  -- The C2 function performs all canonical validation and locks the profile,
  -- schedule, meeting type, matching override, and idempotency row. This call
  -- and the token-hash write share one PostgreSQL transaction.
  v_booking := public.create_booking_atomically(
    p_profile_slug,
    p_meeting_type_id,
    p_requested_local,
    p_requested_offset_minutes,
    p_guest_timezone,
    p_guest_name,
    p_guest_email,
    p_guest_phone,
    p_notes,
    p_idempotency_key
  );

  select b.manage_token_hash into v_stored_hash
  from public.bookings b
  where b.id = v_booking.id
  for update;

  if v_stored_hash is null then
    update public.bookings
    set manage_token_hash = p_manage_token_hash,
        updated_at = now()
    where id = v_booking.id;
  elsif v_stored_hash <> p_manage_token_hash then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;

  select b.* into v_booking from public.bookings b where b.id = v_booking.id;
  return v_booking;
end;
$$;

create or replace function public.get_guest_booking_details(
  p_booking_id uuid,
  p_manage_token_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_booking_id is null or p_manage_token_hash is null or p_manage_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
  end if;

  select jsonb_build_object(
    'id', b.id,
    'status', b.status,
    'guest_name', b.guest_name,
    'guest_email', b.guest_email,
    'guest_timezone', b.guest_timezone,
    'starts_at', b.starts_at,
    'ends_at', b.ends_at,
    'notes', b.notes,
    'host_timezone', s.timezone,
    'meeting_type', jsonb_build_object(
      'name_en', mt.name_en,
      'name_ar', mt.name_ar,
      'duration_minutes', mt.duration_minutes,
      'mode', mt.mode
    )
  ) into v_result
  from public.bookings b
  left join public.meeting_types mt on mt.id = b.meeting_type_id
  left join public.availability_schedules s on s.owner_id = b.owner_id and s.is_default = true
  where b.id = p_booking_id
    and b.manage_token_hash = p_manage_token_hash;

  if v_result is null then
    raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
  end if;
  return v_result;
end;
$$;

create or replace function public.cancel_booking_atomically(
  p_booking_id uuid,
  p_actor_type text,
  p_owner_id uuid,
  p_manage_token_hash text,
  p_cancellation_reason text,
  p_operation_key text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
  v_prior public.booking_history;
  v_reason text;
  v_fingerprint text;
  v_actor_id uuid;
begin
  if p_booking_id is null
     or p_actor_type is null
     or p_actor_type not in ('host', 'guest')
     or p_operation_key is null
     or p_operation_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  v_reason := nullif(trim(coalesce(p_cancellation_reason, '')), '');
  if length(v_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  select b.* into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    if p_actor_type = 'guest' then
      raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
    end if;
    raise exception using errcode = 'P0001', message = 'BOOKING_NOT_FOUND';
  end if;

  if p_actor_type = 'host' then
    if p_owner_id is null or p_owner_id <> v_booking.owner_id then
      raise exception using errcode = 'P0001', message = 'BOOKING_NOT_FOUND';
    end if;
    v_actor_id := p_owner_id;
  else
    if p_manage_token_hash is null or p_manage_token_hash !~ '^[a-f0-9]{64}$'
       or p_manage_token_hash <> v_booking.manage_token_hash then
      raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
    end if;
    v_actor_id := null;
  end if;

  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'operation', 'cancel',
    'booking_id', v_booking.id,
    'actor_type', p_actor_type,
    'actor_id', v_actor_id,
    'reason', v_reason
  )::text, 'sha256'), 'hex');

  select h.* into v_prior from public.booking_history h
  where h.booking_id = v_booking.id and h.operation_key = p_operation_key;
  if found then
    if v_prior.request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_booking;
  end if;

  if v_booking.status = 'cancelled' then
    return v_booking;
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'INVALID_BOOKING_STATE';
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancellation_reason = v_reason,
      updated_at = now()
  where id = v_booking.id
  returning * into v_booking;

  insert into public.booking_history (
    booking_id, event_type, old_starts_at, old_ends_at,
    new_starts_at, new_ends_at, actor_type, actor_id,
    operation_key, request_fingerprint, metadata
  ) values (
    v_booking.id, 'cancelled', v_booking.starts_at, v_booking.ends_at,
    null, null, p_actor_type, v_actor_id,
    p_operation_key, v_fingerprint, jsonb_build_object('reason', v_reason)
  );

  return v_booking;
end;
$$;

create or replace function public.reschedule_booking_atomically(
  p_booking_id uuid,
  p_actor_type text,
  p_owner_id uuid,
  p_manage_token_hash text,
  p_requested_local timestamp without time zone,
  p_requested_offset_minutes integer,
  p_requested_timezone text,
  p_operation_key text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings;
  v_prior public.booking_history;
  v_schedule public.availability_schedules;
  v_override public.availability_overrides;
  v_duration integer;
  v_before integer;
  v_after integer;
  v_minimum_notice integer;
  v_horizon integer;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_occupied_starts_at timestamptz;
  v_occupied_ends_at timestamptz;
  v_local_end timestamp without time zone;
  v_weekday integer;
  v_actor_id uuid;
  v_fingerprint text;
  v_old_starts_at timestamptz;
  v_old_ends_at timestamptz;
begin
  if p_booking_id is null
     or p_actor_type is null
     or p_actor_type not in ('host', 'guest')
     or p_requested_local is null
     or p_requested_offset_minutes is null
     or p_requested_offset_minutes not between -840 and 840
     or p_requested_timezone is null
     or p_operation_key is null
     or p_operation_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  select b.* into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    if p_actor_type = 'guest' then
      raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
    end if;
    raise exception using errcode = 'P0001', message = 'BOOKING_NOT_FOUND';
  end if;

  if p_actor_type = 'host' then
    if p_owner_id is null or p_owner_id <> v_booking.owner_id then
      raise exception using errcode = 'P0001', message = 'BOOKING_NOT_FOUND';
    end if;
    v_actor_id := p_owner_id;
  else
    if p_manage_token_hash is null or p_manage_token_hash !~ '^[a-f0-9]{64}$'
       or p_manage_token_hash <> v_booking.manage_token_hash then
      raise exception using errcode = 'P0001', message = 'INVALID_MANAGE_TOKEN';
    end if;
    v_actor_id := null;
  end if;

  -- Fingerprint intentionally excludes mutable booking state so a retry after
  -- a successful move still matches the original operation.
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'operation', 'reschedule',
    'booking_id', p_booking_id,
    'actor_type', p_actor_type,
    'actor_id', v_actor_id,
    'requested_local', p_requested_local,
    'requested_offset_minutes', p_requested_offset_minutes,
    'requested_timezone', p_requested_timezone
  )::text, 'sha256'), 'hex');

  select h.* into v_prior from public.booking_history h
  where h.booking_id = v_booking.id and h.operation_key = p_operation_key;
  if found then
    if v_prior.request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_booking;
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'INVALID_BOOKING_STATE';
  end if;

  select s.* into v_schedule from public.availability_schedules s
  where s.owner_id = v_booking.owner_id and s.is_default = true
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;
  if p_requested_timezone <> v_schedule.timezone
     or not exists (select 1 from pg_timezone_names z where z.name = v_schedule.timezone)
     or v_booking.guest_timezone is null
     or not exists (select 1 from pg_timezone_names z where z.name = v_booking.guest_timezone) then
    raise exception using errcode = 'P0001', message = 'INVALID_TIMEZONE';
  end if;

  select mt.duration_minutes, mt.buffer_before_minutes, mt.buffer_after_minutes,
         coalesce(mt.minimum_notice_minutes, br.minimum_notice_minutes, 0),
         coalesce(mt.booking_horizon_days, br.maximum_days_ahead, 60)
  into v_duration, v_before, v_after, v_minimum_notice, v_horizon
  from public.meeting_types mt
  left join public.booking_rules br on br.owner_id = mt.owner_id
  where mt.id = v_booking.meeting_type_id
    and mt.owner_id = v_booking.owner_id
    and mt.active = true
  for share of mt;
  if v_duration is null then
    raise exception using errcode = 'P0001', message = 'INACTIVE_MEETING_TYPE';
  end if;

  if p_requested_local::time = time '24:00'
     or date_trunc('minute', p_requested_local) <> p_requested_local then
    raise exception using errcode = 'P0001', message = 'INVALID_LOCAL_TIME';
  end if;
  v_starts_at := (p_requested_local - make_interval(mins => p_requested_offset_minutes)) at time zone 'UTC';
  if (v_starts_at at time zone v_schedule.timezone) <> p_requested_local then
    raise exception using errcode = 'P0001', message = 'INVALID_LOCAL_TIME';
  end if;

  v_ends_at := v_starts_at + make_interval(mins => v_duration);
  v_local_end := p_requested_local + make_interval(mins => v_duration);
  if v_local_end::date <> p_requested_local::date then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;
  if v_starts_at <= now() + make_interval(mins => v_minimum_notice) then
    raise exception using errcode = 'P0001', message = 'TOO_SOON';
  end if;
  if v_starts_at >= now() + make_interval(days => v_horizon) then
    raise exception using errcode = 'P0001', message = 'BEYOND_BOOKING_HORIZON';
  end if;

  v_weekday := extract(dow from p_requested_local)::integer;
  select o.* into v_override from public.availability_overrides o
  where o.owner_id = v_booking.owner_id
    and o.override_date = p_requested_local::date
    and (o.schedule_id is null or o.schedule_id = v_schedule.id)
  for share;
  if found and not v_override.is_available then
    raise exception using errcode = 'P0001', message = 'DATE_UNAVAILABLE';
  elsif found and (
    p_requested_local::time < v_override.start_local
    or v_local_end::time > v_override.end_local
  ) then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  elsif not found and not exists (
    select 1 from public.availability_intervals i
    where i.schedule_id = v_schedule.id
      and i.weekday = v_weekday
      and p_requested_local::time >= i.start_local
      and v_local_end::time <= i.end_local
  ) then
    raise exception using errcode = 'P0001', message = 'OUTSIDE_AVAILABILITY';
  end if;

  v_occupied_starts_at := v_starts_at - make_interval(mins => v_before);
  v_occupied_ends_at := v_ends_at + make_interval(mins => v_after);
  v_old_starts_at := v_booking.starts_at;
  v_old_ends_at := v_booking.ends_at;

  begin
    update public.bookings
    set starts_at = v_starts_at,
        ends_at = v_ends_at,
        occupied_starts_at = v_occupied_starts_at,
        occupied_ends_at = v_occupied_ends_at,
        updated_at = now()
    where id = v_booking.id
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception using errcode = 'P0001', message = 'SLOT_TAKEN';
  end;

  insert into public.booking_history (
    booking_id, event_type, old_starts_at, old_ends_at,
    new_starts_at, new_ends_at, actor_type, actor_id,
    operation_key, request_fingerprint, metadata
  ) values (
    v_booking.id, 'rescheduled',
    v_old_starts_at, v_old_ends_at, v_starts_at, v_ends_at, p_actor_type, v_actor_id,
    p_operation_key, v_fingerprint,
    jsonb_build_object('requested_timezone', v_schedule.timezone)
  );

  return v_booking;
end;
$$;

create or replace function public.mutate_availability_override(
  p_operation text,
  p_owner_id uuid,
  p_schedule_id uuid,
  p_override_id uuid,
  p_override_date date,
  p_is_available boolean,
  p_start_local time without time zone,
  p_end_local time without time zone,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_target_schedule uuid;
  v_current public.availability_overrides;
  v_result public.availability_overrides;
begin
  if p_owner_id is null or p_operation is null or p_operation not in ('create', 'update', 'delete') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if p_operation = 'create' then
    if p_override_id is not null or p_override_date is null or p_is_available is null then
      raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
    end if;
    v_target_schedule := p_schedule_id;
  else
    if p_override_id is null then
      raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
    end if;
    select o.* into v_current from public.availability_overrides o
    where o.id = p_override_id and o.owner_id = p_owner_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'OVERRIDE_NOT_FOUND';
    end if;
    v_target_schedule := coalesce(v_current.schedule_id, p_schedule_id);
  end if;

  if v_target_schedule is null then
    select s.id into v_target_schedule from public.availability_schedules s
    where s.owner_id = p_owner_id and s.is_default = true;
  end if;
  if v_target_schedule is null then
    raise exception using errcode = 'P0001', message = 'SCHEDULE_NOT_FOUND';
  end if;

  perform 1 from public.availability_schedules s
  where s.id = v_target_schedule and s.owner_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SCHEDULE_NOT_FOUND';
  end if;

  if p_operation = 'delete' then
    select o.* into v_current from public.availability_overrides o
    where o.id = p_override_id and o.owner_id = p_owner_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'OVERRIDE_NOT_FOUND';
    end if;
    delete from public.availability_overrides where id = v_current.id;
    return jsonb_build_object('id', v_current.id, 'deleted', true);
  end if;

  if p_override_date is null or p_is_available is null
     or (p_is_available and (p_start_local is null or p_end_local is null or p_start_local >= p_end_local))
     or (not p_is_available and (p_start_local is not null or p_end_local is not null))
     or length(coalesce(p_reason, '')) > 500 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if p_operation = 'create' then
    insert into public.availability_overrides (
      owner_id, schedule_id, override_date, is_available, start_local, end_local, reason
    ) values (
      p_owner_id, v_target_schedule, p_override_date, p_is_available,
      p_start_local, p_end_local, nullif(trim(p_reason), '')
    ) returning * into v_result;
  else
    select o.* into v_current from public.availability_overrides o
    where o.id = p_override_id and o.owner_id = p_owner_id
    for update;
    if not found or coalesce(v_current.schedule_id, v_target_schedule) <> v_target_schedule then
      raise exception using errcode = 'P0001', message = 'OVERRIDE_NOT_FOUND';
    end if;
    update public.availability_overrides
    set override_date = p_override_date,
        is_available = p_is_available,
        start_local = p_start_local,
        end_local = p_end_local,
        reason = nullif(trim(p_reason), '')
    where id = p_override_id
    returning * into v_result;
  end if;
  return to_jsonb(v_result);
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'OVERRIDE_CONFLICT';
end;
$$;

revoke all on function public.create_booking_with_management_atomically(text, uuid, timestamp without time zone, integer, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_booking_with_management_atomically(text, uuid, timestamp without time zone, integer, text, text, text, text, text, text, text) to service_role;
revoke all on function public.get_guest_booking_details(uuid, text) from public, anon, authenticated;
grant execute on function public.get_guest_booking_details(uuid, text) to service_role;
revoke all on function public.cancel_booking_atomically(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.cancel_booking_atomically(uuid, text, uuid, text, text, text) to service_role;
revoke all on function public.reschedule_booking_atomically(uuid, text, uuid, text, timestamp without time zone, integer, text, text) from public, anon, authenticated;
grant execute on function public.reschedule_booking_atomically(uuid, text, uuid, text, timestamp without time zone, integer, text, text) to service_role;
revoke all on function public.mutate_availability_override(text, uuid, uuid, uuid, date, boolean, time without time zone, time without time zone, text) from public, anon, authenticated;
grant execute on function public.mutate_availability_override(text, uuid, uuid, uuid, date, boolean, time without time zone, time without time zone, text) to service_role;

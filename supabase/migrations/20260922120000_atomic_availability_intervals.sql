-- Atomic replacement for one owner's structured availability intervals.
-- The Express server is the trusted caller in the current architecture.
-- Supabase Auth / auth.uid() authorization is intentionally deferred.

create or replace function public.replace_availability_intervals(
  p_owner_id uuid,
  p_schedule_id uuid,
  p_intervals jsonb
)
returns setof public.availability_intervals
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_existing jsonb;
  v_weekday smallint;
  v_start time;
  v_end time;
  v_validated jsonb := '[]'::jsonb;
  v_schedule_id uuid;
begin
  if p_owner_id is null or p_schedule_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'Invalid availability ownership payload.';
  end if;

  if p_intervals is null or jsonb_typeof(p_intervals) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = 'Availability intervals payload must be a JSON array.';
  end if;

  -- Validate the complete payload before any existing interval is deleted.
  for v_item in select value from jsonb_array_elements(p_intervals)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ? 'weekday')
       or not (v_item ? 'start_local')
       or not (v_item ? 'end_local')
       or jsonb_typeof(v_item->'weekday') <> 'number'
       or (v_item->>'weekday') !~ '^-?[0-9]+$'
       or jsonb_typeof(v_item->'start_local') <> 'string'
       or jsonb_typeof(v_item->'end_local') <> 'string'
       or nullif(v_item->>'start_local', '') is null
       or nullif(v_item->>'end_local', '') is null then
      raise exception using
        errcode = 'P0001',
        message = 'Each availability interval must contain weekday, start_local, and end_local.';
    end if;

    begin
      v_weekday := (v_item->>'weekday')::smallint;
      v_start := (v_item->>'start_local')::time;
      v_end := (v_item->>'end_local')::time;
    exception when invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range then
      raise exception using
        errcode = 'P0001',
        message = 'Availability interval contains an invalid weekday or time.';
    end;

    if v_weekday not between 0 and 6 then
      raise exception using
        errcode = 'P0001',
        message = 'Availability weekday must be between 0 and 6.';
    end if;

    if v_start >= v_end then
      raise exception using
        errcode = 'P0001',
        message = 'Availability interval start must be before its end.';
    end if;

    for v_existing in select value from jsonb_array_elements(v_validated)
    loop
      if (v_existing->>'weekday')::smallint = v_weekday
         and (v_existing->>'start_local')::time = v_start
         and (v_existing->>'end_local')::time = v_end then
        raise exception using
          errcode = 'P0001',
          message = 'Duplicate availability intervals are not allowed.';
      end if;

      if (v_existing->>'weekday')::smallint = v_weekday
         and v_start < (v_existing->>'end_local')::time
         and (v_existing->>'start_local')::time < v_end then
        raise exception using
          errcode = 'P0001',
          message = 'Availability intervals cannot overlap.';
      end if;
    end loop;

    v_validated := v_validated || jsonb_build_array(jsonb_build_object(
      'weekday', v_weekday,
      'start_local', v_start,
      'end_local', v_end
    ));
  end loop;

  select s.id
    into v_schedule_id
  from public.availability_schedules s
  where s.id = p_schedule_id
    and s.owner_id = p_owner_id
  for update;

  if v_schedule_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Availability schedule was not found for this owner.';
  end if;

  delete from public.availability_intervals
  where schedule_id = v_schedule_id;

  insert into public.availability_intervals (schedule_id, weekday, start_local, end_local)
  select
    v_schedule_id,
    (item->>'weekday')::smallint,
    (item->>'start_local')::time,
    (item->>'end_local')::time
  from jsonb_array_elements(v_validated) item;

  return query
  select i.*
  from public.availability_intervals i
  where i.schedule_id = v_schedule_id
  order by i.weekday, i.start_local, i.end_local, i.id;
end;
$$;

revoke all on function public.replace_availability_intervals(uuid, uuid, jsonb) from public;
revoke all on function public.replace_availability_intervals(uuid, uuid, jsonb) from anon;
revoke all on function public.replace_availability_intervals(uuid, uuid, jsonb) from authenticated;
grant execute on function public.replace_availability_intervals(uuid, uuid, jsonb) to service_role;

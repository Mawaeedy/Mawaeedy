const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const sql = fs.readFileSync('supabase/migrations/20260922140000_atomic_booking.sql', 'utf8');
const correctiveSql = fs.readFileSync('supabase/migrations/20260922150000_fix_booking_idempotency_fingerprint.sql', 'utf8');

test('C2 migration creates the approved occupied-range and idempotency contract', () => {
  assert.match(sql, /create extension if not exists btree_gist/i);
  assert.match(sql, /add column if not exists occupied_starts_at timestamptz/i);
  assert.match(sql, /add column if not exists occupied_ends_at timestamptz/i);
  assert.match(sql, /add column if not exists idempotency_key text/i);
  assert.match(sql, /add column if not exists request_fingerprint text/i);
  assert.match(sql, /create unique index if not exists bookings_owner_idempotency_key_idx/i);
  assert.match(sql, /owner_id with =/i);
  assert.match(sql, /tstzrange\(occupied_starts_at, occupied_ends_at, '\[\)'\) with &&/i);
  assert.match(sql, /where \(status = 'confirmed'\)/i);
  assert.match(sql, /event_type in \('created', 'rescheduled', 'cancelled'\)/i);
  assert.match(sql, /status in \('confirmed', 'cancelled'\)/i);
});

test('C2 migration defines a server-only invoker RPC with the required validation boundaries', () => {
  assert.match(sql, /create or replace function public\.create_booking_atomically/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = public, pg_temp/i);
  assert.match(sql, /grant execute on function public\.create_booking_atomically[\s\S]*to service_role/i);
  assert.match(sql, /revoke all on function public\.create_booking_atomically[\s\S]*from public/i);
  assert.match(sql, /revoke all on function public\.create_booking_atomically[\s\S]*from anon/i);
  assert.match(sql, /revoke all on function public\.create_booking_atomically[\s\S]*from authenticated/i);
  assert.match(sql, /p_requested_local timestamp without time zone/i);
  assert.match(sql, /p_requested_offset_minutes integer/i);
  assert.match(sql, /extensions\.digest\(/i);
  assert.doesNotMatch(sql, /(?<!extensions\.)digest\(/i);
  assert.match(sql, /at time zone 'UTC'/i);
  assert.match(sql, /at time zone v_host_timezone/i);
  assert.match(sql, /message = 'INVALID_TIMEZONE'/i);
  assert.match(sql, /message = 'INVALID_LOCAL_TIME'/i);
  assert.match(sql, /message = 'INACTIVE_MEETING_TYPE'/i);
  assert.match(sql, /message = 'DATE_UNAVAILABLE'/i);
  assert.match(sql, /message = 'TOO_SOON'/i);
  assert.match(sql, /message = 'BEYOND_BOOKING_HORIZON'/i);
});

test('C2 availability validation uses the actual meeting interval, never the occupied buffer range', () => {
  const availabilityBlock = sql.slice(sql.indexOf('if found and ('), sql.indexOf('v_occupied_starts_at :='));
  assert.match(availabilityBlock, /p_requested_local::time/);
  assert.match(availabilityBlock, /v_local_end::time/);
  assert.doesNotMatch(availabilityBlock, /v_occupied_starts_at/);
  assert.doesNotMatch(availabilityBlock, /v_occupied_ends_at/);
  assert.match(sql, /when exclusion_violation then[\s\S]*message = 'SLOT_TAKEN'/i);
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /update\s+public\.bookings/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.bookings\s*\([^)]*\)\s*select/i);
});

test('the corrective migration preserves the applied migration and replaces only the RPC fingerprint', () => {
  assert.equal(require('crypto').createHash('sha256').update(sql).digest('hex'), '7ed4dcde352e7b71e6a122ce79d486131a86b2ad6cc62c43cd9440f02197902f');
  assert.match(correctiveSql, /create or replace function public\.create_booking_atomically/i);
  assert.match(correctiveSql, /security invoker/i);
  assert.match(correctiveSql, /set search_path = public, pg_temp/i);
  assert.match(correctiveSql, /extensions\.digest\(/i);
  assert.match(correctiveSql, /jsonb_build_object\(/i);
  assert.doesNotMatch(correctiveSql, /concat_ws\(/i);
  assert.match(correctiveSql, /'guest_name',\s*trim\(p_guest_name\)/i);
  assert.match(correctiveSql, /'guest_email',\s*lower\(trim\(p_guest_email\)\)/i);
  assert.match(correctiveSql, /'guest_phone',\s*nullif\(trim\(p_guest_phone\), ''\)/i);
  assert.match(correctiveSql, /'notes',\s*nullif\(trim\(p_notes\), ''\)/i);
  assert.match(correctiveSql, /'profile_slug',\s*lower\(trim\(p_profile_slug\)\)/i);
  assert.match(correctiveSql, /'meeting_type_id',\s*p_meeting_type_id::text/i);
  assert.match(correctiveSql, /'requested_local',\s*p_requested_local/i);
  assert.match(correctiveSql, /'requested_offset_minutes',\s*p_requested_offset_minutes/i);
  assert.match(correctiveSql, /'guest_timezone',\s*p_guest_timezone/i);
  assert.match(correctiveSql, /revoke all on function public\.create_booking_atomically[\s\S]*from public/i);
  assert.match(correctiveSql, /revoke all on function public\.create_booking_atomically[\s\S]*from anon/i);
  assert.match(correctiveSql, /revoke all on function public\.create_booking_atomically[\s\S]*from authenticated/i);
  assert.match(correctiveSql, /grant execute on function public\.create_booking_atomically[\s\S]*to service_role/i);
});

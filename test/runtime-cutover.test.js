const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createSupabaseAdapter, createSqliteAdapter } = require('../persistence/repository');
const { resolvePersistenceBackend } = require('../config');
const { normalizeIntervals, normalizeOverride, validateSchedule } = require('../core/validation');
const { convertLegacyAvailabilityRules, sanitizePublicAvailability } = require('../core/availability');

function fakeDb(initial = {}) {
  let value = structuredClone({
    users: [{ id: 'user-a' }],
    profile: { name: 'Ali', slug: 'ali' },
    meetingTypes: [{ id: 'type-a', name: 'اجتماع', en: 'Meeting', duration: 30, active: true }],
    ...initial
  });
  return { read: () => structuredClone(value), write: next => { value = structuredClone(next); }, snapshot: () => structuredClone(value) };
}

function fakeSupabase() {
  const calls = [];
  const data = {
    profiles: [{ id: 'user-a', name: 'Ali', job_title: 'Manager', timezone: 'Asia/Riyadh', slug: 'ali', locale: 'ar' }],
    meeting_types: [{ id: 'type-a', owner_id: 'user-a', name_ar: 'اجتماع', name_en: 'Meeting', duration_minutes: 30, active: true }]
  };
  return {
    calls,
    async list(table, query) { calls.push(['list', table, query]); return data[table] || []; },
    async update(table, values, query) { calls.push(['update', table, values, query]); return [{ ...(data[table]?.[0] || {}), ...values }]; },
    async insert(table, values) { calls.push(['insert', table, values]); return [{ id: 'new-type', ...values }]; }
  };
}

test('profile owner operations are scoped and public lookup is limited', async () => {
  const client = fakeSupabase();
  const repo = createSupabaseAdapter(client);
  const profile = await repo.getProfileByOwner('user-a');
  assert.equal(profile.id, 'user-a');
  await repo.updateProfile('user-a', { name: 'Updated', locale: 'en' });
  const update = client.calls.find(call => call[0] === 'update');
  assert.match(update[3], /id=eq\.user-a/);
  const publicResult = await repo.getPublicProfileBySlug('ali');
  assert.deepEqual(publicResult.profile, { name: 'Ali', photo: '', bio: '', title: 'Manager', job_title: 'Manager', location: '', timezone: 'Asia/Riyadh', slug: 'ali' });
});

test('meeting type operations scope every owner query and reject invalid input', async () => {
  const client = fakeSupabase();
  const repo = createSupabaseAdapter(client);
  const listed = await repo.listMeetingTypes('user-a');
  assert.equal(listed[0].id, 'type-a');
  await repo.createMeetingType('user-a', { nameAr: 'جديد', nameEn: 'New', duration: 30 });
  await repo.updateMeetingType('user-a', 'type-a', { duration: 45 });
  await repo.deactivateMeetingType('user-a', 'type-a');
  for (const call of client.calls.filter(call => ['list', 'update'].includes(call[0]))) assert.match(call[0] === 'update' ? call[3] : call[2], /owner_id=eq\.user-a|id=eq\.user-a/);
  await assert.rejects(() => repo.createMeetingType('user-a', { nameAr: 'Bad', nameEn: 'Bad', duration: 3 }), /Duration/);
});

test('explicit SQLite mode is isolated to the local adapter', async () => {
  const db = fakeDb();
  const repo = createSqliteAdapter(db);
  assert.equal((await repo.getProfileByOwner('user-b')), null);
  assert.equal((await repo.listMeetingTypes('user-b')).length, 0);
  const created = await repo.createMeetingType('user-a', { nameAr: 'جلسة', nameEn: 'Session', duration: 30 });
  assert.equal(created.en, 'Session');
  assert.equal(db.snapshot().meetingTypes.length, 2);
});

test('persistence backend resolution is explicit and production fails closed', () => {
  assert.equal(resolvePersistenceBackend({ PERSISTENCE_BACKEND: 'supabase', NODE_ENV: 'production' }), 'supabase');
  assert.equal(resolvePersistenceBackend({ PERSISTENCE_BACKEND: 'sqlite', NODE_ENV: 'development' }), 'sqlite');
  assert.throws(() => resolvePersistenceBackend({ PERSISTENCE_BACKEND: 'sqlite', NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => resolvePersistenceBackend({ PERSISTENCE_BACKEND: 'unknown', NODE_ENV: 'development' }), /must be either/);
  assert.throws(() => execFileSync(process.execPath, ['-e', "process.env.NODE_ENV='production'; process.env.PERSISTENCE_BACKEND='sqlite'; require('./config')"], { cwd: process.cwd(), stdio: 'pipe' }), /Production requires/);
});

test('structured availability validates timezone, duplicates, and overlaps', () => {
  assert.equal(validateSchedule({ timezone: 'Asia/Riyadh' }).timezone, 'Asia/Riyadh');
  assert.throws(() => validateSchedule({ timezone: 'GMT+3' }), /IANA/);
  assert.deepEqual(normalizeIntervals([{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }, { weekday: 1, startLocal: '13:00', endLocal: '17:00' }]).length, 2);
  assert.throws(() => normalizeIntervals([{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }, { weekday: 1, startLocal: '11:00', endLocal: '13:00' }]), /overlap/);
  assert.throws(() => normalizeIntervals([{ weekday: 7, startLocal: '09:00', endLocal: '10:00' }]), /between 0 and 6/);
});

test('SQLite availability adapter supports owner-scoped schedules, intervals, and overrides', async () => {
  const db = fakeDb();
  const repo = createSqliteAdapter(db);
  const schedule = await repo.createAvailabilitySchedule('user-a', { name: 'Work', timezone: 'Asia/Riyadh', isDefault: true });
  await repo.replaceScheduleIntervals('user-a', schedule.id, [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }, { weekday: 1, startLocal: '13:00', endLocal: '17:00' }]);
  const unavailable = await repo.createAvailabilityOverride('user-a', { scheduleId: schedule.id, overrideDate: '2026-10-05', isAvailable: false });
  const available = await repo.createAvailabilityOverride('user-a', { scheduleId: schedule.id, overrideDate: '2026-10-06', isAvailable: true, startLocal: '10:00', endLocal: '11:00' });
  assert.equal((await repo.getAvailability('user-b')).schedule, null);
  const result = await repo.getAvailability('user-a');
  assert.equal(result.schedule.timezone, 'Asia/Riyadh');
  assert.equal(result.intervals.length, 2);
  assert.equal(result.overrides.length, 2);
  assert.equal((await repo.updateAvailabilityOverride('user-b', unavailable.id, { reason: 'no' })), null);
  assert.equal((await repo.deleteAvailabilityOverride('user-b', available.id)), null);
});

test('first-time availability is empty and never synthesized from legacy defaults', async () => {
  const db = fakeDb({ availability: { monday: '09:00–18:00' } });
  const repo = createSqliteAdapter(db);
  assert.deepEqual(await repo.getAvailability('user-a'), { schedule: null, intervals: [], overrides: [] });
});

test('explicit availability supports disabled weekdays and separated intervals', async () => {
  const db = fakeDb();
  const repo = createSqliteAdapter(db);
  const schedule = await repo.createAvailabilitySchedule('user-a', { name: 'Work', timezone: 'Asia/Riyadh', isDefault: true });
  const result = await repo.replaceScheduleIntervals('user-a', schedule.id, [
    { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
    { weekday: 1, startLocal: '13:00', endLocal: '17:00' }
  ]);
  assert.equal(result.intervals.some(item => item.weekday === 0), false);
  assert.equal(result.intervals.length, 2);
});

test('existing default availability is updated without creating another schedule', async () => {
  const db = fakeDb();
  const repo = createSqliteAdapter(db);
  const first = await repo.createAvailabilitySchedule('user-a', { name: 'Work', timezone: 'Asia/Riyadh', isDefault: true });
  await repo.replaceScheduleIntervals('user-a', first.id, [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }]);
  await repo.replaceScheduleIntervals('user-a', first.id, [{ weekday: 2, startLocal: '10:00', endLocal: '14:00' }]);
  const schedules = await repo.listAvailabilitySchedules('user-a');
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].id, first.id);
  assert.equal((await repo.getAvailability('user-a')).intervals[0].weekday, 2);
});

test('structured availability rejects cross-owner schedule mutation', async () => {
  const db = fakeDb();
  const repo = createSqliteAdapter(db);
  const schedule = await repo.createAvailabilitySchedule('user-a', { name: 'Work', timezone: 'Asia/Riyadh', isDefault: true });
  assert.equal(await repo.updateAvailabilitySchedule('user-b', schedule.id, { name: 'Hijack' }), null);
  await assert.rejects(() => repo.replaceScheduleIntervals('user-b', schedule.id, [{ weekday: 1, startLocal: '09:00', endLocal: '10:00' }]), /Owner profile not found/);
});

function atomicSupabaseClient({ rpcError = null } = {}) {
  const calls = [];
  const schedule = { id: 'schedule-a', owner_id: 'user-a', name: 'Work', timezone: 'Asia/Riyadh', is_default: true, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z' };
  const interval = { id: 'interval-a', schedule_id: 'schedule-a', weekday: 1, start_local: '09:00:00', end_local: '12:00:00' };
  return {
    calls,
    async list(table, query) {
      calls.push(['list', table, query]);
      if (table === 'availability_schedules') return [schedule];
      if (table === 'availability_intervals') return [interval];
      if (table === 'availability_overrides') return [];
      return [];
    },
    async rpc(name, payload) {
      calls.push(['rpc', name, payload]);
      if (rpcError) throw new Error(rpcError);
      return [interval];
    }
  };
}

test('Supabase availability replacement uses one owner-scoped RPC and supports []', async () => {
  const client = atomicSupabaseClient();
  const repo = createSupabaseAdapter(client);
  await repo.replaceScheduleIntervals('user-a', 'schedule-a', []);
  const rpcCall = client.calls.find(call => call[0] === 'rpc');
  assert.equal(rpcCall[1], 'replace_availability_intervals');
  assert.deepEqual(rpcCall[2], { p_owner_id: 'user-a', p_schedule_id: 'schedule-a', p_intervals: [] });
  assert.equal(client.calls.some(call => call[0] === 'remove'), false);
  assert.equal(client.calls.some(call => call[0] === 'insert'), false);
});

test('Supabase RPC failure is controlled and does not fall back to SQLite or REST writes', async () => {
  const client = atomicSupabaseClient({ rpcError: 'Supabase 400: Availability intervals cannot overlap.' });
  const repo = createSupabaseAdapter(client);
  await assert.rejects(() => repo.replaceScheduleIntervals('user-a', 'schedule-a', [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }]), /Availability intervals cannot overlap/);
  assert.equal(client.calls.some(call => call[0] === 'remove'), false);
  assert.equal(client.calls.some(call => call[0] === 'insert'), false);
});

test('atomic migration contains locking, validation, and server-only permissions', () => {
  const sql = fs.readFileSync('supabase/migrations/20260922120000_atomic_availability_intervals.sql', 'utf8');
  assert.match(sql, /security invoker/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /jsonb_typeof\(p_intervals\)/i);
  assert.match(sql, /p_intervals is null/i);
  assert.match(sql, /revoke all on function public\.replace_availability_intervals/i);
  assert.match(sql, /grant execute on function public\.replace_availability_intervals[\s\S]*to service_role/i);
});

test('legacy availability conversion is deterministic and public output is sanitized', () => {
  const converted = convertLegacyAvailabilityRules('user-a', [
    { day_of_week: 1, start_time: '09:00:00', end_time: '12:00:00' },
    { day_of_week: 1, start_time: '13:00:00', end_time: '17:00:00' }
  ], 'Asia/Baghdad');
  assert.equal(converted.schedule.timezone, 'Asia/Baghdad');
  assert.equal(converted.intervals.length, 2);
  const publicValue = sanitizePublicAvailability({ schedule: { id: 'private', owner_id: 'user-a', name: 'Work', timezone: 'Asia/Baghdad' }, intervals: [{ id: 'private', scheduleId: 'private', weekday: 1, startLocal: '09:00', endLocal: '12:00' }], overrides: [] });
  assert.equal(publicValue.schedule.id, undefined);
  assert.equal(publicValue.intervals[0].scheduleId, undefined);
});

test('legacy availability conversion requires an explicit timezone', () => {
  assert.throws(() => convertLegacyAvailabilityRules('user-a', [
    { day_of_week: 1, start_time: '09:00:00', end_time: '12:00:00' }
  ]), /Schedule timezone must be a valid IANA timezone/);
});

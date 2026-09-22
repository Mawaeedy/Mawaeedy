const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfilePatch, validateMeetingType, normalizeInterval, overlaps } = require('../core/validation');
const { createCoreRepository } = require('../supabase/core-repository');

function fakeRelationalClient() {
  const tables = new Map();
  let sequence = 0;
  const calls = [];
  return {
    calls,
    tables,
    async list(table, query) { calls.push(['list', table, query]); return tables.get(table) || []; },
    async insert(table, values) {
      calls.push(['insert', table, values]);
      const rows = Array.isArray(values) ? values : [values];
      const created = rows.map(row => ({ id: `row-${++sequence}`, ...row }));
      tables.set(table, [...(tables.get(table) || []), ...created]);
      return created;
    },
    async update(table, values, query) { calls.push(['update', table, values, query]); return [{ ...values }]; }
  };
}

test('profile validation normalizes a safe slug and locale', () => {
  assert.deepEqual(validateProfilePatch({ name: 'Ali', slug: 'Ali-Hussein', locale: 'en', timezone: 'Asia/Riyadh' }), {
    displayName: 'Ali', bookingSlug: 'ali-hussein', locale: 'en', timezone: 'Asia/Riyadh'
  });
  assert.throws(() => validateProfilePatch({ slug: 'not valid' }));
});

test('meeting type and availability validation enforce relational constraints', () => {
  assert.deepEqual(validateMeetingType({ duration: 30, bufferBeforeMinutes: 5, bufferAfterMinutes: 10 }), { durationMinutes: 30, bufferBeforeMinutes: 5, bufferAfterMinutes: 10, bookingHorizonDays: null });
  assert.throws(() => validateMeetingType({ duration: 3 }));
  assert.deepEqual(normalizeInterval({ weekday: 0, startLocal: '09:00', endLocal: '12:00' }), { weekday: 0, startLocal: '09:00', endLocal: '12:00' });
  assert.throws(() => normalizeInterval({ weekday: 0, startLocal: '12:00', endLocal: '09:00' }));
  assert.equal(overlaps(540, 600, 570, 630), true);
  assert.equal(overlaps(540, 600, 600, 630), false);
});

test('core repository always scopes writes to the authenticated owner', async () => {
  const client = fakeRelationalClient();
  const repo = createCoreRepository(client);
  await repo.createMeetingType('user-a', { nameAr: 'اجتماع', nameEn: 'Meeting', duration: 30 });
  await repo.replaceAvailability('user-a', { timezone: 'Asia/Riyadh' }, [{ weekday: 0, startLocal: '09:00', endLocal: '12:00' }, { weekday: 0, startLocal: '13:00', endLocal: '17:00' }]);
  const booking = await repo.createBooking('user-a', { meetingTypeId: 'type-a', guestName: 'Guest', guestEmail: 'guest@example.com', startsAt: '2026-09-24T06:00:00Z', endsAt: '2026-09-24T06:30:00Z' });
  assert.equal(client.tables.get('meeting_types')[0].owner_id, 'user-a');
  assert.equal(client.tables.get('availability_schedules')[0].owner_id, 'user-a');
  assert.equal(client.tables.get('availability_intervals').length, 2);
  assert.equal(booking.owner_id, 'user-a');
  await assert.rejects(() => repo.getProfile(), /Authenticated owner id/);
});

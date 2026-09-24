const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createSupabaseBookingRepository } = require('../persistence/booking-repository');
const { resolveLocalWallClock } = require('../core/timezone');
const server = require('../server');

function publicInput(overrides = {}) {
  return {
    profileSlug: 'ahmed',
    meetingTypeId: 'meeting-type-1',
    requestedLocal: '2026-10-01 09:00:00',
    requestedOffsetMinutes: 180,
    guestTimezone: 'Asia/Riyadh',
    guestName: 'Guest Name',
    guestEmail: 'guest@example.com',
    idempotencyKey: 'attempt-1234567890',
    ...overrides
  };
}

test('Supabase public booking creation calls only the atomic RPC', async () => {
  const calls = [];
  const repository = createSupabaseBookingRepository({
    async rpc(name, values) {
      calls.push(['rpc', name, values]);
      return [{ id: 'booking-1', owner_id: 'owner-1', meeting_type_id: 'meeting-type-1', guest_name: 'Guest Name', guest_email: 'guest@example.com', starts_at: '2026-10-01T06:00:00.000Z', ends_at: '2026-10-01T06:30:00.000Z', status: 'confirmed', created_at: '2026-09-30T00:00:00.000Z' }];
    }
  });
  const booking = await repository.createPublicBooking({ ...publicInput(), manageTokenHash: 'a'.repeat(64) });
  assert.equal(booking.id, 'booking-1');
  assert.equal(calls[0][1], 'create_booking_with_management_atomically');
  assert.equal(calls[0][2].p_idempotency_key, 'attempt-1234567890');
  assert.equal(calls[0][2].p_manage_token_hash, 'a'.repeat(64));
});

test('production booking source has no direct Supabase bookings insert or client-controlled canonical fields', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const repository = fs.readFileSync('persistence/booking-repository.js', 'utf8');
  assert.doesNotMatch(server, /\.insert\(['"]bookings['"]/i);
  assert.doesNotMatch(repository, /client\.insert\(['"]bookings['"]/i);
  assert.match(server, /bookingService\.createPublicBooking/);
  assert.match(server, /BOOKING_FAILED/);
  assert.doesNotMatch(server, /owner_id\s*:\s*body\./i);
  assert.doesNotMatch(server, /occupied_(?:starts|ends)_at\s*:\s*body\./i);
  assert.doesNotMatch(server, /ends_at\s*:\s*body\./i);
});

test('server-side timezone resolution accepts Riyadh and rejects DST gaps/ambiguity', () => {
  assert.deepEqual(resolveLocalWallClock('2026-09-23 09:00:00', 'Asia/Riyadh').status, 'resolved');
  assert.equal(resolveLocalWallClock('2026-03-08 02:30:00', 'America/New_York').status, 'nonexistent');
  assert.equal(resolveLocalWallClock('2026-11-01 01:30:00', 'America/New_York').status, 'ambiguous');
});

test('Supabase booking creation resolves and returns times in the saved schedule timezone', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf("app.post('/api/bookings'");
  const end = source.indexOf("app.get('/api/availability'", start);
  const route = source.slice(start, end);
  assert.match(route, /const hostTimezone = publicState\.availability\?\.schedule\?\.timezone \|\| publicState\.profile\.timezone/);
  assert.match(route, /resolveLocalWallClock\(`\$\{date\} \$\{time\}:00`, hostTimezone\)/);
  assert.match(route, /publicBookingResponse\(booking, meetingType, hostTimezone, manageToken\)/);
});

test('public slot availability filters confirmed bookings using occupied ranges and selected meeting duration', () => {
  const { publicAvailabilitySlots } = require('../core/public-availability');
  const base = {
    date: '2026-09-27', timezone: 'Asia/Baghdad',
    availability: { schedule: { timezone: 'Asia/Baghdad' }, intervals: [{ weekday: 0, startLocal: '09:00', endLocal: '12:00' }], overrides: [] },
    meetingTypes: [{ id: 'type-30', duration: 30, active: true, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }, { id: 'type-60', duration: 60, active: true, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }],
    bookings: [{ id: 'existing', status: 'confirmed', starts_at: '2026-09-27T06:00:00.000Z', ends_at: '2026-09-27T06:30:00.000Z', occupied_starts_at: '2026-09-27T06:00:00.000Z', occupied_ends_at: '2026-09-27T06:30:00.000Z' }, { id: 'cancelled', status: 'cancelled', starts_at: '2026-09-27T06:30:00.000Z', ends_at: '2026-09-27T07:00:00.000Z', occupied_starts_at: '2026-09-27T06:30:00.000Z', occupied_ends_at: '2026-09-27T07:00:00.000Z' }]
  };
  assert.deepEqual(publicAvailabilitySlots({ ...base, meetingTypeId: 'type-30' }), ['09:30', '10:00', '10:30', '11:00', '11:30']);
  assert.deepEqual(publicAvailabilitySlots({ ...base, meetingTypeId: 'type-60' }), ['09:30', '10:00', '10:30', '11:00']);
});

test('public availability request is owner-scoped and refreshed when the guest changes meeting type', () => {
  const repository = fs.readFileSync('persistence/repository.js', 'utf8');
  const serverSource = fs.readFileSync('server.js', 'utf8');
  const client = fs.readFileSync('app.js', 'utf8');
  assert.match(repository, /return \{ ownerId: row\.id, profile: publicProfile\(row\)/);
  assert.match(serverSource, /bookingService\.listOwnerBookings\(publicState\.ownerId, \{ status: 'confirmed' \}\)/);
  assert.match(serverSource, /publicAvailabilitySlots\(\{ date, timezone, availability: publicState\.availability, bookings, meetingTypes, meetingTypeId: requestedTypeId \}\)/);
  assert.match(client, /meetingTypeId=\$\{encodeURIComponent\(meetingTypeId\|\|''\)\}/);
  assert.match(client, /e\.target\.id === 'typeSelect'.*syncGuestSlots\(date, e\.target\.value\)/);
});

test('browser booking attempt creates a key and sends only guest scheduling inputs', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  assert.match(app, /newBookingAttemptKey/);
  assert.match(app, /idempotencyKey:key/);
  assert.match(app, /profileSlug:location\.pathname/);
  assert.doesNotMatch(app, /owner_id\s*:/i);
  assert.doesNotMatch(app, /occupied_(?:starts|ends)_at\s*:/i);
});

test('booking database errors are sanitized into stable public responses', () => {
  const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const conflict = response();
  server.sendBookingError(conflict, { supabase: { message: 'SLOT_TAKEN', code: 'P0001', hint: 'private constraint detail' } });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.body, { error: 'SLOT_TAKEN' });
  const unknown = response();
  server.sendBookingError(unknown, { supabase: { message: 'secret postgres message', code: 'XX000', hint: 'internal hint' } });
  assert.equal(unknown.statusCode, 503);
  assert.deepEqual(unknown.body, { error: 'BOOKING_FAILED' });
  assert.doesNotMatch(JSON.stringify(unknown.body), /secret|postgres|internal/i);
});

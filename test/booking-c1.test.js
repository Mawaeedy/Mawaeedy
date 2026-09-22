const test = require('node:test');
const assert = require('node:assert/strict');
const { BookingOperationUnavailableError, BookingValidationError, mapBooking, normalizeBookingInput } = require('../core/booking');
const { createBookingRepository } = require('../persistence/booking-repository');
const { createBookingService } = require('../services/booking-service');

function fakeDb(initial = {}) {
  let state = structuredClone({ bookings: [], ...initial });
  return {
    read: () => structuredClone(state),
    write: next => { state = structuredClone(next); },
    snapshot: () => structuredClone(state)
  };
}

function canonicalInput(overrides = {}) {
  return {
    ownerId: 'owner-a',
    meetingTypeId: 'type-a',
    guestName: 'Guest Name',
    guestEmail: 'guest@example.com',
    guestTimezone: 'Asia/Riyadh',
    startsAt: '2026-10-01T06:00:00.000Z',
    endsAt: '2026-10-01T06:30:00.000Z',
    ...overrides
  };
}

test('canonical booking mapping normalizes persisted fields and rejects malformed time', () => {
  const booking = mapBooking({ id: 'booking-a', owner_id: 'owner-a', meeting_type_id: 'type-a', guest_name: 'Guest', guest_email: 'guest@example.com', starts_at: '2026-10-01T06:00:00.000Z', ends_at: '2026-10-01T06:30:00.000Z' }, 'owner-a');
  assert.equal(booking.owner_id, 'owner-a');
  assert.equal(booking.guest_email, 'guest@example.com');
  assert.throws(() => normalizeBookingInput(canonicalInput({ endsAt: 'not-a-date' })), BookingValidationError);
  assert.throws(() => normalizeBookingInput(canonicalInput({ guestTimezone: 'GMT+3' })), /IANA/);
});

test('SQLite development repository keeps private reads owner-scoped at the boundary', async () => {
  const db = fakeDb({ bookings: [{ id: 'booking-a', name: 'Guest', email: 'guest@example.com', date: '2026-10-01', time: '09:00', meetingTypeId: 'type-a', status: 'confirmed', createdAt: '2026-09-30T00:00:00.000Z' }] });
  const repository = createBookingRepository({ backend: 'sqlite', db });
  const service = createBookingService(repository);
  const rows = await service.listOwnerBookings('owner-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, 'owner-a');
  assert.equal((await service.getBooking('owner-a', 'missing')), null);
});

test('SQLite development repository characterizes current create behavior behind the service', async () => {
  const db = fakeDb();
  const service = createBookingService(createBookingRepository({ backend: 'sqlite', db }));
  const created = await service.createBooking(canonicalInput());
  assert.equal(created.owner_id, 'owner-a');
  assert.equal(db.snapshot().bookings.length, 1);
  assert.equal(db.snapshot().bookings[0].meetingTypeId, 'type-a');
});

test('Supabase adapter lists only owner rows and does not silently fall back', async () => {
  const calls = [];
  const client = {
    async list(table, query) {
      calls.push(['list', table, query]);
      return [{ id: 'booking-a', owner_id: 'owner-a', meeting_type_id: 'type-a', guest_name: 'Guest', guest_email: 'guest@example.com', starts_at: '2026-10-01T06:00:00.000Z', ends_at: '2026-10-01T06:30:00.000Z' }];
    }
  };
  const repository = createBookingRepository({ backend: 'supabase', supabaseClient: client });
  const service = createBookingService(repository);
  const rows = await service.listOwnerBookings('owner-a');
  assert.equal(rows[0].owner_id, 'owner-a');
  assert.match(calls[0][2], /owner_id=eq\.owner-a/);
  await assert.rejects(() => service.createBooking(canonicalInput()), BookingOperationUnavailableError);
});

test('booking service delegates supported reads and preserves explicit unsupported operations', async () => {
  const calls = [];
  const repository = {
    backend: 'test',
    capabilities: { atomicCreate: true },
    async getBooking(ownerId, id) { calls.push(['get', ownerId, id]); return { id }; },
    async listOwnerBookings(ownerId) { calls.push(['list', ownerId]); return [{ id: 'a', status: 'confirmed' }, { id: 'b', status: 'cancelled' }]; },
    async createBooking(ownerId, input) { calls.push(['create', ownerId]); return { ...input, owner_id: ownerId }; },
    async cancelBooking() { throw new BookingOperationUnavailableError('not in C1'); },
    async rescheduleBooking() { throw new BookingOperationUnavailableError('not in C1'); }
  };
  const service = createBookingService(repository);
  assert.equal((await service.getBooking('owner-a', 'booking-a')).id, 'booking-a');
  assert.equal((await service.listOwnerBookings('owner-a', { status: 'confirmed' })).length, 1);
  await service.createBooking(canonicalInput());
  await assert.rejects(() => service.cancelBooking('owner-a', 'booking-a'), BookingOperationUnavailableError);
  assert.deepEqual(calls.map(call => call[0]), ['get', 'list', 'create']);
});

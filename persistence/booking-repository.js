const crypto = require('crypto');
const { BookingOperationUnavailableError, mapBooking, normalizeBookingInput, normalizePublicBookingInput } = require('../core/booking');

function ownerFilter(ownerId) {
  if (!ownerId) throw new Error('Authenticated owner id is required.');
  return `owner_id=eq.${encodeURIComponent(ownerId)}`;
}

function legacyToCanonical(row, ownerId) {
  if (!row) return null;
  const start = row.starts_at || `${row.date}T${row.time}:00.000Z`;
  const end = row.ends_at || new Date(new Date(start).getTime() + 30 * 60 * 1000).toISOString();
  return mapBooking({
    ...row,
    owner_id: row.owner_id || ownerId,
    meeting_type_id: row.meeting_type_id || row.meetingTypeId,
    guest_name: row.guest_name || row.name,
    guest_email: row.guest_email || row.email,
    starts_at: start,
    ends_at: end,
    created_at: row.created_at || row.createdAt,
    updated_at: row.updated_at || row.updatedAt
  }, ownerId);
}

function canonicalToLegacy(row) {
  const date = row.starts_at.slice(0, 10);
  const time = row.starts_at.slice(11, 16);
  return {
    ...row,
    owner_id: row.owner_id,
    name: row.guest_name,
    email: row.guest_email,
    date,
    time,
    meetingTypeId: row.meeting_type_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createSqliteBookingRepository(db) {
  return {
    backend: 'sqlite',
    capabilities: { atomicCreate: false, atomicCancel: false, atomicReschedule: false },
    async getBooking(ownerId, bookingId) {
      const state = db.read();
      return legacyToCanonical((state.bookings || []).find(row => String(row.id) === String(bookingId)), ownerId);
    },
    async listOwnerBookings(ownerId) {
      const state = db.read();
      return (state.bookings || []).map(row => legacyToCanonical(row, ownerId));
    },
    async createBooking(ownerId, input) {
      const booking = normalizeBookingInput({ ...input, ownerId });
      const state = db.read();
      state.bookings = state.bookings || [];
      state.bookings.push(canonicalToLegacy(booking));
      db.write(state);
      return booking;
    },
    async createPublicBooking(input) {
      const normalized = normalizePublicBookingInput(input);
      const ownerId = input.ownerId || input.owner_id || 'owner';
      const startsAt = `${normalized.requested_local.replace(' ', 'T')}.000Z`;
      const booking = normalizeBookingInput({
        ...normalized,
        ownerId,
        meetingTypeId: normalized.meeting_type_id,
        guestName: normalized.guest_name,
        guestEmail: normalized.guest_email,
        guestTimezone: normalized.guest_timezone,
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString()
      });
      const state = db.read();
      state.bookings = state.bookings || [];
      state.bookings.push(canonicalToLegacy(booking));
      db.write(state);
      return booking;
    },
    async cancelBooking() {
      throw new BookingOperationUnavailableError('SQLite cancellation is retained only for legacy route compatibility until C2/C4.');
    },
    async rescheduleBooking() {
      throw new BookingOperationUnavailableError('SQLite rescheduling is retained only for legacy route compatibility until C2/C5.');
    }
  };
}

function createSupabaseBookingRepository(client) {
  return {
    backend: 'supabase',
    capabilities: { atomicCreate: true, atomicCancel: false, atomicReschedule: false },
    async getBooking(ownerId, bookingId) {
      const rows = await client.list('bookings', `?${ownerFilter(ownerId)}&id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`);
      return rows[0] ? mapBooking(rows[0], ownerId) : null;
    },
    async listOwnerBookings(ownerId) {
      const rows = await client.list('bookings', `?${ownerFilter(ownerId)}&select=*&order=starts_at.asc`);
      return rows.map(row => mapBooking(row, ownerId));
    },
    async createBooking(ownerId, input) {
      return this.createPublicBooking({ ...input, ownerId });
    },
    async createPublicBooking(input) {
      const normalized = normalizePublicBookingInput(input);
      const rows = await client.rpc('create_booking_atomically', {
        p_profile_slug: normalized.profile_slug,
        p_meeting_type_id: normalized.meeting_type_id,
        p_requested_local: normalized.requested_local,
        p_requested_offset_minutes: Number(normalized.requested_offset_minutes),
        p_guest_timezone: normalized.guest_timezone,
        p_guest_name: normalized.guest_name,
        p_guest_email: normalized.guest_email,
        p_guest_phone: normalized.guest_phone,
        p_notes: normalized.notes,
        p_idempotency_key: normalized.idempotency_key
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ? mapBooking(row, row.owner_id) : null;
    },
    async cancelBooking() {
      throw new BookingOperationUnavailableError('Supabase booking cancellation requires the C2 atomic booking design.');
    },
    async rescheduleBooking() {
      throw new BookingOperationUnavailableError('Supabase booking rescheduling requires the C2 atomic booking design.');
    }
  };
}

function createBookingRepository({ backend, db, supabaseClient }) {
  if (backend === 'sqlite') return createSqliteBookingRepository(db);
  if (backend === 'supabase') return createSupabaseBookingRepository(supabaseClient);
  throw new Error(`Unsupported booking repository backend: ${backend}`);
}

module.exports = {
  createBookingRepository,
  createSqliteBookingRepository,
  createSupabaseBookingRepository
};

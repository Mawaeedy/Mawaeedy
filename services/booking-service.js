const { BookingOperationUnavailableError, normalizeBookingInput, normalizePublicBookingInput } = require('../core/booking');

function createBookingService(repository) {
  if (!repository) throw new Error('Booking repository is required.');

  return {
    async getBooking(ownerId, bookingId) {
      return repository.getBooking(ownerId, bookingId);
    },
    async listOwnerBookings(ownerId, filters = {}) {
      const rows = await repository.listOwnerBookings(ownerId, filters);
      return rows.filter(row => !filters.status || row.status === filters.status);
    },
    async createBooking(input) {
      const normalized = normalizeBookingInput(input);
      if (repository.capabilities?.atomicCreate === false && repository.backend === 'supabase') {
        throw new BookingOperationUnavailableError('Supabase booking creation is intentionally unavailable before C2.');
      }
      return repository.createBooking(normalized.owner_id, normalized);
    },
    async createPublicBooking(input) {
      const normalized = normalizePublicBookingInput(input);
      if (typeof repository.createPublicBooking !== 'function') throw new BookingOperationUnavailableError('Public booking creation is unavailable.');
      return repository.createPublicBooking({ ...normalized, manageTokenHash: input.manageTokenHash });
    },
    async getGuestBooking(bookingId, manageTokenHash) {
      if (typeof repository.getGuestBooking !== 'function') throw new BookingOperationUnavailableError('Guest booking management is unavailable.');
      return repository.getGuestBooking(bookingId, manageTokenHash);
    },
    async cancelGuestBooking(bookingId, input = {}) {
      if (typeof repository.cancelGuestBooking !== 'function') throw new BookingOperationUnavailableError('Guest cancellation is unavailable.');
      return repository.cancelGuestBooking(bookingId, input);
    },
    async rescheduleGuestBooking(bookingId, input = {}) {
      if (typeof repository.rescheduleGuestBooking !== 'function') throw new BookingOperationUnavailableError('Guest rescheduling is unavailable.');
      return repository.rescheduleGuestBooking(bookingId, input);
    },
    async cancelBooking(ownerId, bookingId, input = {}) {
      if (!ownerId) throw new Error('Authenticated owner id is required.');
      return repository.cancelBooking(ownerId, bookingId, input);
    },
    async rescheduleBooking(ownerId, bookingId, input = {}) {
      if (!ownerId) throw new Error('Authenticated owner id is required.');
      return repository.rescheduleBooking(ownerId, bookingId, input);
    }
  };
}

module.exports = { createBookingService };

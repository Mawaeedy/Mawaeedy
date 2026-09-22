const { BookingOperationUnavailableError, normalizeBookingInput } = require('../core/booking');

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

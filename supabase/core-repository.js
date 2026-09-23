const { validateProfilePatch, validateMeetingType, normalizeInterval } = require('../core/validation');

function ownerFilter(ownerId) {
  if (!ownerId) throw new Error('Authenticated owner id is required.');
  return `?owner_id=eq.${encodeURIComponent(ownerId)}`;
}

function createCoreRepository(client) {
  return {
    async getProfile(ownerId) {
      if (!ownerId) throw new Error('Authenticated owner id is required.');
      const rows = await client.list('profiles', `?id=eq.${encodeURIComponent(ownerId)}&select=*`);
      return rows[0] || null;
    },
    async updateProfile(ownerId, input) {
      const normalized = validateProfilePatch(input);
      const values = {
        ...(normalized.displayName === undefined ? {} : { name: normalized.displayName }),
        ...(normalized.bookingSlug === undefined ? {} : { slug: normalized.bookingSlug }),
        ...(normalized.locale === undefined ? {} : { locale: normalized.locale }),
        ...(normalized.timezone === undefined ? {} : { timezone: normalized.timezone })
      };
      const rows = await client.update('profiles', values, `?id=eq.${encodeURIComponent(ownerId)}`);
      return rows[0] || null;
    },
    async listMeetingTypes(ownerId) {
      return client.list('meeting_types', `${ownerFilter(ownerId)}&active=eq.true&order=created_at.asc`);
    },
    async createMeetingType(ownerId, input) {
      const values = validateMeetingType(input);
      const rows = await client.insert('meeting_types', {
        owner_id: ownerId,
        name_ar: String(input.nameAr ?? input.name ?? '').trim(),
        name_en: String(input.nameEn ?? input.en ?? '').trim(),
        duration_minutes: values.durationMinutes,
        buffer_before_minutes: values.bufferBeforeMinutes,
        buffer_after_minutes: values.bufferAfterMinutes,
        booking_horizon_days: values.bookingHorizonDays,
        mode: input.locationType || input.mode || 'custom',
        active: true
      });
      return rows[0] || null;
    },
    async replaceAvailability(ownerId, schedule, intervals) {
      if (!ownerId) throw new Error('Authenticated owner id is required.');
      if (!schedule?.timezone) throw new Error('Schedule timezone is required.');
      const normalized = intervals.map(normalizeInterval);
      const schedules = await client.insert('availability_schedules', { owner_id: ownerId, name: schedule.name || 'Default schedule', timezone: schedule.timezone, is_default: true });
      const created = schedules[0];
      if (!created?.id) throw new Error('Availability schedule was not persisted.');
      if (normalized.length) await client.insert('availability_intervals', normalized.map(interval => ({ schedule_id: created.id, ...interval })));
      return { schedule: created, intervals: normalized };
    },
    async createBooking(ownerId, booking) {
      if (!ownerId) throw new Error('Authenticated owner id is required.');
      if (typeof client.rpc !== 'function') throw new Error('Atomic booking RPC client is required.');
      const rows = await client.rpc('create_booking_atomically', {
        p_profile_slug: booking.profileSlug,
        p_meeting_type_id: booking.meetingTypeId,
        p_requested_local: booking.requestedLocal,
        p_requested_offset_minutes: booking.requestedOffsetMinutes,
        p_guest_timezone: booking.guestTimezone,
        p_guest_name: booking.guestName,
        p_guest_email: booking.guestEmail,
        p_guest_phone: booking.guestPhone || null,
        p_notes: booking.notes || null,
        p_idempotency_key: booking.idempotencyKey
      });
      return Array.isArray(rows) ? rows[0] || null : rows;
    }
  };
}

module.exports = { createCoreRepository };

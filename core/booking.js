const crypto = require('crypto');

class BookingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookingValidationError';
  }
}

class BookingOperationUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookingOperationUnavailableError';
  }
}

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function validInstant(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new BookingValidationError(`${label} must be a valid UTC instant.`);
  return date.toISOString();
}

function normalizePublicBookingInput(input = {}) {
  const profileSlug = String(input.profileSlug ?? input.profile_slug ?? '').trim().toLowerCase();
  const meetingTypeId = String(input.meetingTypeId ?? input.meeting_type_id ?? '').trim();
  const requestedLocal = String(input.requestedLocal ?? input.requested_local ?? '').trim();
  const guestName = String(input.guestName ?? input.guest_name ?? input.name ?? '').trim();
  const guestEmail = String(input.guestEmail ?? input.guest_email ?? input.email ?? '').trim().toLowerCase();
  const guestTimezone = input.guestTimezone ?? input.guest_timezone;
  const idempotencyKey = String(input.idempotencyKey ?? input.idempotency_key ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profileSlug)) throw new BookingValidationError('Booking profile is invalid.');
  if (!meetingTypeId) throw new BookingValidationError('Meeting type is required.');
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(requestedLocal)) throw new BookingValidationError('Booking time is invalid.');
  if (!guestName) throw new BookingValidationError('Guest name is required.');
  if (!/^\S+@\S+\.\S+$/.test(guestEmail)) throw new BookingValidationError('Guest email is invalid.');
  if (!isValidTimezone(guestTimezone)) throw new BookingValidationError('Guest timezone must be a valid IANA timezone.');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new BookingValidationError('Booking attempt key is invalid.');
  const requestedOffsetMinutes = Number(input.requestedOffsetMinutes ?? input.requested_offset_minutes);
  if (!Number.isInteger(requestedOffsetMinutes) || requestedOffsetMinutes < -840 || requestedOffsetMinutes > 840) throw new BookingValidationError('Booking timezone offset is invalid.');
  return {
    profile_slug: profileSlug,
    meeting_type_id: meetingTypeId,
    requested_local: requestedLocal.replace('T', ' '),
    guest_timezone: guestTimezone,
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: input.guestPhone ?? input.guest_phone ?? null,
    notes: input.notes ?? null,
    idempotency_key: idempotencyKey,
    requested_offset_minutes: requestedOffsetMinutes
  };
}

function normalizeBookingInput(input = {}) {
  const ownerId = String(input.ownerId ?? input.owner_id ?? '').trim();
  const meetingTypeId = String(input.meetingTypeId ?? input.meeting_type_id ?? '').trim();
  const guestName = String(input.guestName ?? input.guest_name ?? '').trim();
  const guestEmail = String(input.guestEmail ?? input.guest_email ?? '').trim().toLowerCase();
  const startsAt = validInstant(input.startsAt ?? input.starts_at, 'Booking start');
  const endsAt = validInstant(input.endsAt ?? input.ends_at, 'Booking end');

  if (!ownerId) throw new BookingValidationError('Booking owner is required.');
  if (!meetingTypeId) throw new BookingValidationError('Meeting type is required.');
  if (!guestName) throw new BookingValidationError('Guest name is required.');
  if (!/^\S+@\S+\.\S+$/.test(guestEmail)) throw new BookingValidationError('Guest email is invalid.');
  if (new Date(endsAt) <= new Date(startsAt)) throw new BookingValidationError('Booking end must be after its start.');
  if (input.guestTimezone !== undefined && input.guestTimezone !== null && !isValidTimezone(input.guestTimezone)) {
    throw new BookingValidationError('Guest timezone must be a valid IANA timezone.');
  }

  return {
    id: input.id || crypto.randomUUID(),
    owner_id: ownerId,
    meeting_type_id: meetingTypeId,
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: input.guestPhone ?? input.guest_phone ?? null,
    guest_timezone: input.guestTimezone ?? input.guest_timezone ?? null,
    starts_at: startsAt,
    ends_at: endsAt,
    status: input.status || 'confirmed',
    manage_token_hash: input.manageTokenHash ?? input.manage_token_hash ?? null,
    external_provider: input.externalProvider ?? input.external_provider ?? null,
    external_event_id: input.externalEventId ?? input.external_event_id ?? null,
    meeting_url: input.meetingUrl ?? input.meeting_url ?? null,
    cancelled_at: input.cancelledAt ?? input.cancelled_at ?? null,
    rescheduled_from_id: input.rescheduledFromId ?? input.rescheduled_from_id ?? null,
    created_at: input.createdAt ?? input.created_at ?? new Date().toISOString(),
    updated_at: input.updatedAt ?? input.updated_at ?? new Date().toISOString()
  };
}

function mapBooking(row, ownerId) {
  if (!row) return null;
  const mapped = normalizeBookingInput({ ...row, owner_id: row.owner_id || ownerId });
  delete mapped.manage_token_hash;
  return {
    ...mapped,
    id: row.id,
    status: row.status || 'confirmed',
    created_at: row.created_at || mapped.created_at,
    updated_at: row.updated_at || mapped.updated_at
  };
}

module.exports = {
  BookingOperationUnavailableError,
  BookingValidationError,
  isValidTimezone,
  mapBooking,
  normalizePublicBookingInput,
  normalizeBookingInput
};

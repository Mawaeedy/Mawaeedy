function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function validateProfilePatch(input = {}) {
  const next = {};
  if (input.displayName !== undefined || input.name !== undefined) next.displayName = requiredText(input.displayName ?? input.name, 'Display name');
  if (input.timezone !== undefined) next.timezone = requiredText(input.timezone, 'Timezone');
  if (input.locale !== undefined) {
    next.locale = String(input.locale);
    if (!['ar', 'en'].includes(next.locale)) throw new Error('Locale must be ar or en.');
  }
  if (input.bookingSlug !== undefined || input.slug !== undefined) {
    next.bookingSlug = String(input.bookingSlug ?? input.slug).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(next.bookingSlug)) throw new Error('Booking slug is invalid.');
  }
  return next;
}

function validateMeetingType(input = {}) {
  const duration = Number(input.durationMinutes ?? input.duration);
  const before = Number(input.bufferBeforeMinutes ?? input.buffer_before_minutes ?? 0);
  const after = Number(input.bufferAfterMinutes ?? input.buffer_after_minutes ?? 0);
  const horizon = input.bookingHorizonDays == null ? null : Number(input.bookingHorizonDays);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new Error('Duration must be between 5 and 480 minutes.');
  if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) throw new Error('Buffers must be non-negative whole minutes.');
  if (horizon !== null && (!Number.isInteger(horizon) || horizon < 1)) throw new Error('Booking horizon must be positive.');
  return { durationMinutes: duration, bufferBeforeMinutes: before, bufferAfterMinutes: after, bookingHorizonDays: horizon };
}

function normalizeInterval(input = {}) {
  const weekday = Number(input.weekday);
  const start = String(input.startLocal ?? input.start_time ?? '');
  const end = String(input.endLocal ?? input.end_time ?? '');
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be between 0 and 6.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) throw new Error('Availability interval must have valid ordered times.');
  return { weekday, startLocal: start, endLocal: end };
}

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return true; } catch { return false; }
}

function validateSchedule(input = {}) {
  const timezone = String(input.timezone || '').trim();
  if (!isValidTimezone(timezone)) throw new Error('Schedule timezone must be a valid IANA timezone.');
  const name = String(input.name || 'Default schedule').trim();
  if (!name) throw new Error('Schedule name is required.');
  return { name, timezone, isDefault: input.isDefault !== false };
}

function normalizeIntervals(intervals = []) {
  if (!Array.isArray(intervals)) throw new Error('Intervals must be an array.');
  const normalized = intervals.map(normalizeInterval).sort((a, b) => a.weekday - b.weekday || a.startLocal.localeCompare(b.startLocal));
  for (let i = 1; i < normalized.length; i += 1) {
    const previous = normalized[i - 1];
    const current = normalized[i];
    if (previous.weekday === current.weekday && previous.startLocal === current.startLocal && previous.endLocal === current.endLocal) throw new Error('Duplicate availability intervals are not allowed.');
    if (previous.weekday === current.weekday && overlaps(previous.startLocal, previous.endLocal, current.startLocal, current.endLocal)) throw new Error('Availability intervals cannot overlap.');
  }
  return normalized;
}

function normalizeOverride(input = {}) {
  const overrideDate = String(input.overrideDate ?? input.override_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) throw new Error('Override date must use YYYY-MM-DD format.');
  const isAvailable = Boolean(input.isAvailable ?? input.is_available);
  const start = input.startLocal ?? input.start_local;
  const end = input.endLocal ?? input.end_local;
  if (!isAvailable) {
    if (start != null || end != null) throw new Error('Unavailable overrides cannot include times.');
    return { overrideDate, isAvailable: false, startLocal: null, endLocal: null, reason: input.reason || null };
  }
  const interval = normalizeInterval({ weekday: 0, startLocal: start, endLocal: end });
  return { overrideDate, isAvailable: true, startLocal: interval.startLocal, endLocal: interval.endLocal, reason: input.reason || null };
}

function overlaps(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

module.exports = { validateProfilePatch, validateMeetingType, normalizeInterval, normalizeIntervals, normalizeOverride, validateSchedule, isValidTimezone, overlaps };

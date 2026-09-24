const { resolveLocalWallClock } = require('./timezone');

function publicAvailabilitySlots({ date, timezone, availability, bookings = [], meetingTypes = [], meetingTypeId, stepMinutes = 30 }) {
  const selectedType = meetingTypes.find(type => String(type.id) === String(meetingTypeId) || String(type.supabaseId) === String(meetingTypeId));
  if (!selectedType || selectedType.active === false) return [];
  if (!availability?.schedule || !Array.isArray(availability.intervals)) return [];

  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const override = (availability.overrides || []).find(item => item.overrideDate === date);
  if (override && !override.isAvailable) return [];
  const intervals = override?.isAvailable
    ? [{ weekday: day, startLocal: override.startLocal, endLocal: override.endLocal }]
    : availability.intervals.filter(item => Number(item.weekday) === day);
  const duration = Number(selectedType.duration || selectedType.durationMinutes || 0);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const candidateBefore = Number(selectedType.bufferBeforeMinutes || 0);
  const candidateAfter = Number(selectedType.bufferAfterMinutes || 0);
  const occupied = bookings.filter(booking => booking.status === 'confirmed').map(booking => {
    const start = Date.parse(booking.occupied_starts_at || booking.starts_at);
    const end = Date.parse(booking.occupied_ends_at || booking.ends_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
    return null;
  }).filter(Boolean);

  const slots = [];
  for (const interval of intervals) {
    const startMinute = Number(String(interval.startLocal).slice(0, 2)) * 60 + Number(String(interval.startLocal).slice(3, 5));
    const endMinute = Number(String(interval.endLocal).slice(0, 2)) * 60 + Number(String(interval.endLocal).slice(3, 5));
    for (let minute = startMinute; minute + duration <= endMinute; minute += stepMinutes) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const resolved = resolveLocalWallClock(`${date} ${time}:00`, timezone);
      if (resolved.status !== 'resolved') continue;
      const candidateStart = Date.parse(resolved.instant) - candidateBefore * 60000;
      const candidateEnd = Date.parse(resolved.instant) + (duration + candidateAfter) * 60000;
      if (!occupied.some(range => candidateStart < range.end && range.start < candidateEnd)) slots.push(time);
    }
  }
  return [...new Set(slots)];
}

module.exports = { publicAvailabilitySlots };

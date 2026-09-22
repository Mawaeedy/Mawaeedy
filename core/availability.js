const { validateSchedule, normalizeIntervals, normalizeOverride } = require('./validation');

function convertLegacyAvailabilityRules(ownerId, rules = [], timezone) {
  const schedule = { owner_id: ownerId, name: 'Legacy weekly schedule', timezone, is_default: true };
  const intervals = rules.map(rule => ({ weekday: Number(rule.day_of_week), startLocal: String(rule.start_time).slice(0, 5), endLocal: String(rule.end_time).slice(0, 5) }));
  return { schedule: validateSchedule(schedule), intervals: normalizeIntervals(intervals) };
}

function sanitizePublicAvailability(value) {
  if (!value?.schedule) return { schedule: null, intervals: [], overrides: [] };
  return {
    schedule: { name: value.schedule.name, timezone: value.schedule.timezone },
    intervals: (value.intervals || []).map(item => ({ weekday: item.weekday, startLocal: item.startLocal, endLocal: item.endLocal })),
    overrides: (value.overrides || []).map(item => ({ overrideDate: item.overrideDate, isAvailable: item.isAvailable, startLocal: item.startLocal || null, endLocal: item.endLocal || null, reason: item.reason || null }))
  };
}

module.exports = { convertLegacyAvailabilityRules, sanitizePublicAvailability };

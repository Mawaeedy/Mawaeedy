function parseLocalWallClock(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second = 0] = parts;
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day || candidate.getUTCHours() !== hour || candidate.getUTCMinutes() !== minute || candidate.getUTCSeconds() !== second) return null;
  return { year, month, day, hour, minute, second, naiveMs: candidate.getTime() };
}

function zonedParts(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instantMs));
  const result = {};
  for (const part of parts) if (part.type !== 'literal') result[part.type] = Number(part.value);
  return result;
}

function offsetAt(instantMs, timezone) {
  const parts = zonedParts(instantMs, timezone);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instantMs) / 60000);
}

function resolveLocalWallClock(value, timezone) {
  const local = parseLocalWallClock(value);
  if (!local) return { status: 'invalid' };
  let offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 3) offsets.add(offsetAt(local.naiveMs + hours * 60 * 60 * 1000, timezone));
  const matches = [...offsets].map(offsetMinutes => ({
    offsetMinutes,
    instant: new Date(local.naiveMs - offsetMinutes * 60000).toISOString()
  })).filter(candidate => {
    const parts = zonedParts(Date.parse(candidate.instant), timezone);
    return parts.year === local.year && parts.month === local.month && parts.day === local.day && parts.hour === local.hour && parts.minute === local.minute && parts.second === local.second;
  });
  if (!matches.length) return { status: 'nonexistent' };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return { status: 'resolved', ...matches[0] };
}

module.exports = { parseLocalWallClock, resolveLocalWallClock };

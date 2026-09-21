const supabase = require('./client');

function parseHours(row) {
  if (!row?.start_time || !row?.end_time) return row?.label || '09:00–18:00';
  return `${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`;
}

function dayName(day) {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][Number(day)] || String(day);
}

async function publicState() {
  const [profiles, types, availability, integrations] = await Promise.all([
    supabase.list('profiles', '?select=*&limit=1'),
    supabase.list('meeting_types', '?select=*&order=created_at.asc'),
    supabase.list('availability_rules', '?select=*&enabled=eq.true&order=day_of_week.asc'),
    supabase.list('integrations', '?select=*')
  ]);
  const profile = profiles[0] || {};
  const meetingTypes = types.map((item, index) => ({
    id: item.legacy_id || item.id || `meeting-${index + 1}`,
    supabaseId: item.id,
    name: item.name_ar || item.name || 'اجتماع',
    en: item.name_en || item.name || 'Meeting',
    duration: Number(item.duration_minutes || item.duration || 30),
    color: item.color || '#2166f3',
    mode: item.location_type || item.mode || 'Google Meet'
  }));
  const availabilityMap = {};
  for (const row of availability) availabilityMap[dayName(row.day_of_week)] = parseHours(row);
  const integrationMap = {};
  for (const row of integrations) integrationMap[row.provider] = Boolean(row.connected);
  return {
    profile: {
      name: profile.name || 'مواعيدي',
      title: profile.title || '',
      location: profile.location || '',
      bio: profile.bio || '',
      photo: profile.photo || '👨🏻‍💼',
      timezone: profile.timezone || 'Asia/Riyadh',
      slug: profile.slug || 'ahmed'
    },
    meetingTypes,
    availability: availabilityMap,
    integrations: integrationMap,
    bookings: []
  };
}

async function ownerProfile() {
  const rows = await supabase.list('profiles', '?select=id&limit=1');
  return rows[0] || null;
}

module.exports = { publicState, ownerProfile };

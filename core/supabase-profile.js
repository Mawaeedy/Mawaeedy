const crypto = require('crypto');

function slugPart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function slugCandidate(name, userId, suffixLength) {
  const base = slugPart(name) || 'host';
  const suffix = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, suffixLength);
  const maxBaseLength = 39 - suffixLength;
  const prefix = base.slice(0, maxBaseLength).replace(/-+$/g, '') || 'host';
  return `${prefix}-${suffix}`;
}

async function ensureSupabaseSchedulingProfile(client, user) {
  if (!client?.list || !client?.insert || !client?.update || !user?.id) {
    throw new Error('Authenticated Supabase user and profile client are required.');
  }

  const userFilter = `?id=eq.${encodeURIComponent(user.id)}&select=id,name,slug,timezone&limit=1`;
  const readProfile = async () => (await client.list('profiles', userFilter))[0] || null;
  const initial = await readProfile();
  if (initial?.slug?.trim()) return initial;

  const name = initial?.name || user.user_metadata?.full_name || user.user_metadata?.name || '';
  const timezone = initial?.timezone || user.user_metadata?.timezone || 'Asia/Riyadh';

  for (const suffixLength of [8, 12, 20, 32]) {
    const slug = slugCandidate(name, user.id, suffixLength);
    const collisions = await client.list('profiles', `?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    if (collisions.some(profile => String(profile.id) !== String(user.id))) continue;

    try {
      const rows = initial
        ? await client.update('profiles', { slug }, `?id=eq.${encodeURIComponent(user.id)}`)
        : await client.insert('profiles', {
            id: user.id,
            name: name || 'Mawaeedy host',
            timezone,
            slug
          });
      const saved = rows[0] || await readProfile();
      if (saved?.slug) return saved;
    } catch (error) {
      const saved = await readProfile();
      if (saved?.slug) return saved;
      if (error?.supabase?.code !== '23505' && error?.supabase?.status !== 409) throw error;
    }
  }

  throw new Error('Unable to assign a unique public booking slug to this profile.');
}

module.exports = { ensureSupabaseSchedulingProfile, slugCandidate, slugPart };

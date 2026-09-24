const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ensureSupabaseSchedulingProfile, slugCandidate } = require('../core/supabase-profile');

function profileClient(initial = null, occupied = []) {
  let row = initial ? { ...initial } : null;
  const writes = [];
  return {
    writes,
    async list(_table, query) {
      if (query.startsWith('?id=')) return row ? [{ ...row }] : [];
      const slug = decodeURIComponent(query.match(/slug=eq\.([^&]+)/)?.[1] || '');
      return [...occupied, ...(row ? [row] : [])].filter(item => item.slug === slug).map(({ id }) => ({ id }));
    },
    async insert(_table, values) {
      writes.push({ operation: 'insert', values });
      row = { ...values };
      return [{ ...row }];
    },
    async update(_table, values) {
      writes.push({ operation: 'update', values });
      row = { ...row, ...values };
      return [{ ...row }];
    }
  };
}

test('Supabase sign-in provisions a stable public slug for a new profile', async () => {
  const client = profileClient();
  const user = { id: 'user-12345678', email: 'ali.hussein@example.com', user_metadata: { full_name: 'علي حسين' } };
  const first = await ensureSupabaseSchedulingProfile(client, user);
  const second = await ensureSupabaseSchedulingProfile(client, user);
  assert.equal(first.slug, second.slug);
  assert.match(first.slug, /^host-[a-f0-9]{8}$/);
  assert.equal(first.name, 'علي حسين');
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].operation, 'insert');
});

test('Supabase sign-in repairs a missing slug without replacing existing profile identity', async () => {
  const client = profileClient({ id: 'owner-98765432', name: 'Host Name', timezone: 'Asia/Baghdad', slug: null });
  const result = await ensureSupabaseSchedulingProfile(client, { id: 'owner-98765432', email: 'host@example.com' });
  assert.equal(result.name, 'Host Name');
  assert.equal(result.timezone, 'Asia/Baghdad');
  assert.match(result.slug, /^host-name-[a-f0-9]{8}$/);
  assert.equal(client.writes[0].operation, 'update');
  assert.deepEqual(client.writes[0].values, { slug: result.slug });
});

test('Supabase sign-in preserves an existing canonical slug and avoids slug collisions', async () => {
  const existing = profileClient({ id: 'owner-a', name: 'Owner', slug: 'custom-link' });
  assert.equal((await ensureSupabaseSchedulingProfile(existing, { id: 'owner-a' })).slug, 'custom-link');
  assert.equal(existing.writes.length, 0);

  const ownerId = 'owner-collision';
  const occupiedSlug = slugCandidate('Ali', ownerId, 8);
  const collision = profileClient(null, [{ id: 'different-owner', slug: occupiedSlug }]);
  const result = await ensureSupabaseSchedulingProfile(collision, { id: ownerId, email: 'ali@example.com', user_metadata: { full_name: 'Ali' } });
  assert.notEqual(result.slug, occupiedSlug);
  assert.match(result.slug, /-[a-f0-9]{12}$/);
});

test('Supabase public slug is never silently replaced with the ahmed test slug', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  const state = fs.readFileSync('supabase/state.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  assert.doesNotMatch(app, /state\.profile\.slug\s*\|\|\s*['"]ahmed['"]/);
  assert.match(app, /أكمل إعداد رابط الحجز أولًا/);
  assert.match(state, /slug:\s*profile\.slug\s*\|\|\s*''/);
  assert.doesNotMatch(state, /profile\.slug\s*\|\|\s*['"]ahmed['"]/);
  assert.equal((server.match(/await ensureSupabaseSchedulingProfile\(client,/g) || []).length, 3);
  assert.match(server, /if \(!config\.useSupabase\) db\.init\(seed\)/);
  assert.match(server, /if \(!authPath && !authenticatedUserId\) return res\.status\(401\)/);
  assert.match(server, /if \(req\.path === '\/api\/auth\/reset-password' && req\.method === 'POST'\)/);
  assert.match(server, /if \(!supportedMutation\) return res\.status\(501\)/);
  assert.match(server, /req\.path === '\/api\/auth\/logout' && req\.method === 'POST'/);
});

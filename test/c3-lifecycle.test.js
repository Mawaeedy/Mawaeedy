const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { deriveManageToken, hashManageToken } = require('../core/manage-token');
const { createSupabaseBookingRepository } = require('../persistence/booking-repository');

const migration = fs.readFileSync('supabase/migrations/20260923100000_booking_lifecycle.sql', 'utf8');
const source = fs.readFileSync('server.js', 'utf8');
const frontend = fs.readFileSync('app.js', 'utf8');
const repositorySource = fs.readFileSync('persistence/booking-repository.js', 'utf8');

test('management token is stable per booking attempt, secret-keyed, and stored only as SHA-256', () => {
  const secret = 'a'.repeat(40), key = 'attempt-1234567890';
  const token = deriveManageToken(key, secret);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(deriveManageToken(key, secret), token);
  assert.notEqual(deriveManageToken(key, 'b'.repeat(40)), token);
  assert.equal(hashManageToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(hashManageToken('short'), null);
  assert.throws(() => deriveManageToken(key, 'tiny'), /32 bytes/);
  assert.match(repositorySource, /p_manage_token_hash/);
  assert.doesNotMatch(source, /manage_tokens*:s*manageToken\b/i);
});

test('new runtime creation uses only the token-aware atomic RPC and never serializes the hash', async () => {
  const calls = [];
  const repository = createSupabaseBookingRepository({ async rpc(name, args) { calls.push({ name, args }); return [{ id: 'booking-id', owner_id: 'host-id', meeting_type_id: 'mt-id', guest_name: 'Guest', guest_email: 'g@example.com', starts_at: '2026-10-01T06:00:00Z', ends_at: '2026-10-01T06:30:00Z', status: 'confirmed' }]; } });
  const result = await repository.createPublicBooking({ profileSlug: 'host', meetingTypeId: 'mt-id', requestedLocal: '2026-10-01 09:00:00', requestedOffsetMinutes: 180, guestTimezone: 'Asia/Riyadh', guestName: 'Guest', guestEmail: 'g@example.com', idempotencyKey: 'attempt-1234567890', manageTokenHash: 'a'.repeat(64) });
  assert.equal(calls[0].name, 'create_booking_with_management_atomically');
  assert.equal(calls[0].args.p_manage_token_hash, 'a'.repeat(64));
  assert.equal(result.id, 'booking-id');
  assert.equal(Object.hasOwn(result, 'manage_token_hash'), false);
});

test('host reads are owner-filtered and lifecycle calls use the intended RPCs', async () => {
  const calls = [];
  const client = { async list(table, query) { calls.push({ table, query }); return []; }, async rpc(name, args) { calls.push({ name, args }); return [{ id: 'b', owner_id: 'owner-1', meeting_type_id: 'mt', guest_name: 'G', guest_email: 'g@example.com', starts_at: '2026-10-01T06:00:00Z', ends_at: '2026-10-01T06:30:00Z', status: 'confirmed' }]; } };
  const repo = createSupabaseBookingRepository(client);
  await repo.listOwnerBookings('owner-1'); await repo.getBooking('owner-2', 'b');
  await repo.cancelBooking('owner-1', 'b', { operationKey: 'op-1234567890123456' });
  await repo.rescheduleBooking('owner-1', 'b', { requestedLocal: '2026-10-02 09:00:00', requestedOffsetMinutes: 180, requestedTimezone: 'Asia/Riyadh', operationKey: 'op-2234567890123456' });
  assert.match(calls[0].query, /owner_id=eq.owner-1/);
  assert.match(calls[1].query, /owner_id=eq.owner-2/);
  assert.equal(calls[2].name, 'cancel_booking_atomically');
  assert.equal(calls[2].args.p_owner_id, 'owner-1');
  assert.equal(calls[3].name, 'reschedule_booking_atomically');
  assert.equal(calls[3].args.p_owner_id, 'owner-1');
});

test('guest management sends only token hash to RPC and frontend strips fragment before API use', () => {
  assert.match(source, /guest\(\?:\\\/\|\$\)/);
  assert.match(source, /requestManageToken\(req\)/);
  assert.match(source, /Authorization/);
  assert.doesNotMatch(source, /req\.query\.token/);
  assert.match(frontend, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.match(frontend, /Authorization:`BookingToken \$\{guestManageToken\}`/);
});

test('lifecycle migration provides invoker RPCs, row locks, idempotency, and service-role-only execution', () => {
  for (const fn of ['create_booking_with_management_atomically','get_guest_booking_details','cancel_booking_atomically','reschedule_booking_atomically','mutate_availability_override']) assert.match(migration, new RegExp(`function public\\.${fn}`, 'i'));
  assert.match(migration, /security invoker/gi);
  assert.match(migration, /set search_path = public, pg_temp/gi);
  assert.match(migration, /for update/gi);
  assert.match(migration, /for share/gi);
  assert.match(migration, /create unique index bookings_manage_token_hash_unique_idx[\s\S]*where manage_token_hash is not null/i);
  assert.match(migration, /create unique index booking_history_booking_operation_key_idx[\s\S]*where operation_key is not null/i);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/i);
  assert.match(migration, /v_booking\.status <> 'confirmed'/i);
  assert.doesNotMatch(migration, /set status.*rescheduled/i);
  assert.doesNotMatch(migration, /https?:\/\//i);
  assert.doesNotMatch(migration, /manage_token_hash.*metadata|metadata.*manage_token_hash/i);
});

test('active override mutations use one schedule-locking RPC, not REST table mutations', () => {
  const repository = fs.readFileSync('persistence/repository.js', 'utf8');
  const supabasePart = repository.slice(repository.indexOf('function createSupabaseAdapter'));
  assert.match(supabasePart, /client\.rpc\('mutate_availability_override'/);
  assert.doesNotMatch(supabasePart, /client\.(?:insert|update|delete)\('availability_overrides'/);
  assert.match(migration, /perform 1 from public\.availability_schedules[\s\S]*for update/i);
});

test('legacy ICS and mutation endpoints require authenticated owner-scoped access', () => {
  assert.match(source, /app\.get\('\/api\/bookings\/:id\/ics', requireAuth/);
  assert.match(source, /app\.patch\('\/api\/bookings\/:id', requireAuth/);
  assert.match(source, /bookingService\.getBooking\(req\.userId, req\.params\.id\)/);
  assert.doesNotMatch(source, /req\.query\.token/);
  assert.match(source, /app\.get\('\/manage\/:bookingId'/);
});

test('public booking date picker includes a full week and selects the date it actually requests', () => {
  assert.match(frontend, /Array\.from\(\{length:7\},\(_,i\)=>`<button class="date \$\{i===0\?'selected':''\}" data-date="\$\{bookingDate\(i\+1\)\}"/);
  assert.match(frontend, /b\.dataset\.date = bookingDate\(i \+ 1\)/);
});

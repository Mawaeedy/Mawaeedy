const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const https = require('https');
const querystring = require('querystring');
const config = require('./config');
const crypto = require('crypto');
const supabaseState = require('./supabase/state');
const { createPersistenceRepository } = require('./persistence/repository');
const { createBookingRepository } = require('./persistence/booking-repository');
const { createBookingService } = require('./services/booking-service');
const { BookingValidationError } = require('./core/booking');
const { resolveLocalWallClock } = require('./core/timezone');
const { normalizeIntervals } = require('./core/validation');
const { deriveManageToken, hashManageToken } = require('./core/manage-token');
const { createPkcePair, pkceVerifierCookie, clearPkceVerifierCookie } = require('./core/supabase-oauth');
const { ensureSupabaseSchedulingProfile } = require('./core/supabase-profile');
const { buildGoogleCallbackUrl } = require('./core/public-url');
const { createSessionToken, verifySessionToken, createSessionCookie } = require('./core/auth-session');

const app = express();
const sessions = new Map();
const revokedSessions = new Set();
const googleTokens = new Map();
const PORT = process.env.PORT || 4173;
const supabaseClient = config.useSupabase ? require('./supabase/client') : null;
const persistence = createPersistenceRepository({ backend: config.persistenceBackend, db, supabaseClient });
const bookingRepository = createBookingRepository({ backend: config.persistenceBackend, db, supabaseClient });
const bookingService = createBookingService(bookingRepository);
const DATA_FILE = path.join(__dirname, 'data.json');
const APP_ROOT = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, '..');
app.use(express.json());
app.use(express.static(APP_ROOT));
app.get('/', (req, res) => res.sendFile(path.join(APP_ROOT, 'index.html')));
app.get(['/login', '/register', '/forgot-password'], (req, res) => res.sendFile(path.join(APP_ROOT, 'auth.html')));
app.get('/book/:slug', (req, res) => res.sendFile(path.join(APP_ROOT, 'booking.html')));
app.get('/manage/:bookingId', (req, res) => res.sendFile(path.join(APP_ROOT, 'booking.html')));

const seed = {
  users: [{ id: 'owner', email: 'ahmed@example.com', password: 'demo', name: 'أحمد الشمري' }],
  profile: { name: 'أحمد الشمري', title: 'Product Manager', location: 'Riyadh, Saudi Arabia', bio: 'أساعد الفرق على بناء منتجات أفضل.', photo: '👨🏻‍💼', timezone: 'Asia/Riyadh' },
  integrations: { googleCalendar: false, googleMeet: false, outlook: false, zoom: false },
  meetingTypes: [
    { id: 'intro', name: 'استشارة عبر الفيديو', en: 'Intro video call', duration: 30, color: '#2166f3', mode: 'Google Meet' },
    { id: 'strategy', name: 'جلسة استراتيجية', en: 'Strategy session', duration: 60, color: '#15a66b', mode: 'Zoom' }
  ],
  availability: { sunday: '09:00–18:00', monday: '09:00–18:00', tuesday: '09:00–18:00', wednesday: '09:00–18:00', thursday: '09:00–15:00', friday: 'Prayer time protected', saturday: '09:00–18:00' },
  bookings: []
};
function readData() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2)); return structuredClone(seed); } }
function writeData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
if (!config.useSupabase) db.init(seed);
function readData() { return db.read(); }
function writeData(d) { db.write(d); }
function bookingOverlaps(d, candidateDate, candidateTime, candidateDuration, ignoreId) { const start = Number(candidateTime.slice(0,2))*60 + Number(candidateTime.slice(3)); const end = start + candidateDuration + Number(d.bookingRules?.bufferMinutes || 0); return d.bookings.some(existing => { if (existing.id === ignoreId || existing.status === 'cancelled' || existing.date !== candidateDate) return false; const type = d.meetingTypes.find(x => x.id === existing.meetingTypeId); const existingStart = Number(existing.time.slice(0,2))*60 + Number(existing.time.slice(3)); const existingEnd = existingStart + Number(type?.duration || 30) + Number(d.bookingRules?.bufferMinutes || 0); return start < existingEnd && existingStart < end; }); }
function bookingOutsideRules(d, date, time) { const rules = d.bookingRules || { minimumNoticeMinutes: 60, maximumDaysAhead: 60 }; const today = new Date(); const slot = new Date(`${date}T${time}:00`); const startOfToday = new Date(`${today.toISOString().slice(0,10)}T00:00:00`); const requestedDay = new Date(`${date}T00:00:00`); const daysAhead = Math.floor((requestedDay - startOfToday) / 86400000); return slot.getTime() - today.getTime() < Number(rules.minimumNoticeMinutes || 0) * 60000 || daysAhead > Number(rules.maximumDaysAhead || 60) || daysAhead < 0; }
function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(password, salt, 64).toString('hex'); return `scrypt$${salt}$${hash}`; }
function verifyPassword(password, stored) { if (!stored?.startsWith('scrypt$')) return stored === password; const [, salt, hash] = stored.split('$'); const actual = crypto.scryptSync(password, salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hash, 'hex')); }
function cookieValue(req, name) { const raw = req.headers.cookie || ''; const item = raw.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`)); return item ? decodeURIComponent(item.slice(name.length + 1)) : null; }
function sessionCookie(token, maxAge = 604800) { return createSessionCookie(token, maxAge, config.isProduction); }
function sessionToken(userId) { return createSessionToken(userId, config.sessionSecret); }
function sessionUser(token) { return verifySessionToken(token, config.sessionSecret); }
function currentUser(req) { const token = cookieValue(req, 'calpro_session'); if (!token || revokedSessions.has(token)) return null; return sessions.get(token) || sessionUser(token); }
function requireAuth(req, res, next) { const userId = currentUser(req); if (!userId) return res.status(401).json({ error: 'Authentication required.' }); req.userId = userId; next(); }
const bookingBusinessErrors = new Set(['SLOT_TAKEN', 'OUTSIDE_AVAILABILITY', 'DATE_UNAVAILABLE', 'INACTIVE_MEETING_TYPE', 'INVALID_TIMEZONE', 'INVALID_LOCAL_TIME', 'TOO_SOON', 'BEYOND_BOOKING_HORIZON', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT']);
function bookingErrorCategory(error) {
  const message = String(error?.supabase?.message || error?.message || '');
  return [...bookingBusinessErrors].find(category => new RegExp(`(?:^|[^A-Z_])${category}(?:$|[^A-Z_])`).test(message)) || null;
}
function sendBookingError(res, error) {
  const category = bookingErrorCategory(error);
  if (category) {
    const status = ['SLOT_TAKEN', 'OUTSIDE_AVAILABILITY', 'DATE_UNAVAILABLE', 'TOO_SOON', 'BEYOND_BOOKING_HORIZON', 'IDEMPOTENCY_CONFLICT'].includes(category) ? 409 : category === 'INACTIVE_MEETING_TYPE' ? 404 : 400;
    return res.status(status).json({ error: category });
  }
  return res.status(503).json({ error: 'BOOKING_FAILED' });
}
const lifecycleErrors = new Set(['BOOKING_NOT_FOUND', 'UNAUTHORIZED_BOOKING_ACCESS', 'INVALID_MANAGE_TOKEN', 'INVALID_BOOKING_STATE', 'IDEMPOTENCY_CONFLICT', 'INVALID_LOCAL_TIME', 'OUTSIDE_AVAILABILITY', 'DATE_UNAVAILABLE', 'TOO_SOON', 'BEYOND_BOOKING_HORIZON', 'SLOT_TAKEN', 'INVALID_TIMEZONE', 'INACTIVE_MEETING_TYPE', 'INVALID_INPUT', 'OVERRIDE_CONFLICT', 'OVERRIDE_NOT_FOUND', 'SCHEDULE_NOT_FOUND']);
function lifecycleErrorCategory(error) {
  const message = String(error?.supabase?.message || error?.message || '');
  return [...lifecycleErrors].find(category => new RegExp(`(?:^|[^A-Z_])${category}(?:$|[^A-Z_])`).test(message)) || null;
}
function sendLifecycleError(res, error) {
  const category = lifecycleErrorCategory(error);
  if (!category) return res.status(503).json({ error: 'BOOKING_LIFECYCLE_FAILED' });
  const status = ['SLOT_TAKEN', 'OUTSIDE_AVAILABILITY', 'DATE_UNAVAILABLE', 'TOO_SOON', 'BEYOND_BOOKING_HORIZON', 'IDEMPOTENCY_CONFLICT', 'INVALID_BOOKING_STATE', 'OVERRIDE_CONFLICT'].includes(category) ? 409
    : ['BOOKING_NOT_FOUND', 'INACTIVE_MEETING_TYPE', 'OVERRIDE_NOT_FOUND', 'SCHEDULE_NOT_FOUND'].includes(category) ? 404
    : ['INVALID_MANAGE_TOKEN', 'UNAUTHORIZED_BOOKING_ACCESS'].includes(category) ? 404 : 400;
  return res.status(status).json({ error: category });
}
function operationKey(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null; }
function bookingView(booking, meetingTypes = [], timezone = 'UTC') {
  if (!booking) return null;
  const startsAt = new Date(booking.starts_at);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(startsAt).reduce((out, part) => { if (part.type !== 'literal') out[part.type] = part.value; return out; }, {});
  const type = meetingTypes.find(item => String(item.id) === String(booking.meeting_type_id) || String(item.supabaseId) === String(booking.meeting_type_id));
  return {
    id: booking.id,
    name: booking.guest_name, email: booking.guest_email,
    guestTimezone: booking.guest_timezone,
    date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`,
    starts_at: booking.starts_at, ends_at: booking.ends_at,
    meetingTypeId: booking.meeting_type_id, meetingType: type?.en || type?.name_en || 'Meeting',
    status: booking.status, notes: booking.notes || null, createdAt: booking.created_at,
    cancelledAt: booking.cancelled_at || null, cancellationReason: booking.cancellation_reason || null
  };
}
function publicBookingResponse(booking, meetingType, timezone, manageToken = null) {
  const startsAt = booking?.starts_at ? new Date(booking.starts_at) : null;
  const formatter = timezone && startsAt ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null;
  const parts = formatter ? formatter.formatToParts(startsAt).reduce((result, part) => { if (part.type !== 'literal') result[part.type] = part.value; return result; }, {}) : {};
  return {
    id: booking.id,
    name: booking.guest_name,
    email: booking.guest_email,
    date: parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : startsAt?.toISOString().slice(0, 10),
    time: parts.hour && parts.minute ? `${parts.hour}:${parts.minute}` : startsAt?.toISOString().slice(11, 16),
    meetingType: meetingType?.en || meetingType?.name_en || 'Meeting',
    status: booking.status,
    createdAt: booking.created_at,
    ...(manageToken ? { managementUrl: `/manage/${encodeURIComponent(booking.id)}#token=${encodeURIComponent(manageToken)}` } : {})
  };
}
function requestManageToken(req) {
  const value = String(req.get('authorization') || '');
  const match = value.match(/^BookingToken ([A-Za-z0-9_-]{43})$/);
  return match ? match[1] : null;
}
function normalizedLocalDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
  return `${date} ${time}:00`;
}
const authAttempts = new Map();
app.use('/api/auth', (req, res, next) => { const key = req.ip || 'local'; const now = Date.now(); const recent = (authAttempts.get(key) || []).filter(t => now - t < 60000); if (recent.length >= 20) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' }); recent.push(now); authAttempts.set(key, recent); next(); });
function httpsRequest(url, options, body) { return new Promise((resolve, reject) => { const request = https.request(url, { method: options.method || 'GET', headers: options.headers || {} }, response => { let data=''; response.on('data', chunk => data += chunk); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(data) }); } catch { reject(new Error('Invalid OAuth provider response.')); } }); }); request.on('error', reject); if (body) request.write(body); request.end(); }); }
async function refreshGoogleToken(userId, token) { if (!token?.refresh_token) return token; const body = querystring.stringify({ client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }); const refreshed = await httpsRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body); if (refreshed.status >= 400) return token; const next = { ...token, ...refreshed.body, refresh_token: token.refresh_token, received_at: Date.now() }; googleTokens.set(userId, next); db.saveOAuthToken(userId, 'google', next, config.tokenEncryptionKey); return next; }
async function googleCalendarRequest(userId, url) { let token = googleTokens.get(userId) || db.getOAuthToken(userId, 'google', config.tokenEncryptionKey); if (!token?.access_token) return null; if (!token.received_at) { token.received_at = Date.now(); db.saveOAuthToken(userId, 'google', token, config.tokenEncryptionKey); } if (token.expires_in && Date.now() > token.received_at + (token.expires_in - 60) * 1000) token = await refreshGoogleToken(userId, token); googleTokens.set(userId, token); return httpsRequest(url, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
async function googleCalendarCreate(userId, booking, type, timezone) { const token = googleTokens.get(userId) || db.getOAuthToken(userId, 'google', config.tokenEncryptionKey); if (!token?.access_token) return null; const start = `${booking.date}T${booking.time}:00`; const endMinutes = Number(booking.time.slice(0,2)) * 60 + Number(booking.time.slice(3)) + Number(type?.duration || 30); const end = `${booking.date}T${String(Math.floor(endMinutes / 60)).padStart(2,'0')}:${String(endMinutes % 60).padStart(2,'0')}:00`; const payload = JSON.stringify({ summary: `${type?.en || 'Meeting'} · ${booking.name}`, description: `Guest email: ${booking.email}${booking.notes ? `\nNotes: ${booking.notes}` : ''}`, start: { dateTime: start, timeZone: timezone || 'Asia/Riyadh' }, end: { dateTime: end, timeZone: timezone || 'Asia/Riyadh' }, conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }); const result = await httpsRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload); if (result.status >= 400) throw new Error('Google Calendar event creation failed.'); return result.body;
}
async function googleCalendarChange(userId, eventId, method, payload = null) { const token = googleTokens.get(userId) || db.getOAuthToken(userId, 'google', config.tokenEncryptionKey); if (!token?.access_token || !eventId) return null; const body = payload ? JSON.stringify(payload) : null; const result = await httpsRequest(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { method, headers: { Authorization: `Bearer ${token.access_token}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } }, body); if (result.status >= 400) throw new Error('Google Calendar update failed.'); return result.body;
}

app.use(async (req, res, next) => {
  const publicBookingPath = req.path === '/api/bookings' || req.path.startsWith('/api/public/') || req.path === '/api/availability/slots' || /^\/api\/bookings\/[^/]+\/guest(?:\/|$)/.test(req.path);
  const supabaseAuthGetPaths = ['/api/auth/google', '/api/auth/google/callback', '/api/auth/me'];
  if (!config.useSupabase || publicBookingPath || (req.method === 'GET' && !supabaseAuthGetPaths.includes(req.path))) return next();
  const client = require('./supabase/client');
  try {
    const authPath = req.path.startsWith('/api/auth/');
    const authenticatedUserId = currentUser(req);
    if (!authPath && !authenticatedUserId) return res.status(401).json({ error: 'Authentication required.' });
    const owner = authPath ? null : await supabaseState.ownerProfile(authenticatedUserId);
    if (config.useSupabase && req.path === '/api/auth/google' && req.method === 'GET') {
      const { verifier, challenge } = createPkcePair();
      const redirectTo = buildGoogleCallbackUrl({
        publicAppUrl: config.publicAppUrl,
        isProduction: config.isProduction,
        forwardedProto: req.get('x-forwarded-proto'),
        requestProtocol: req.protocol,
        host: req.get('host')
      });
      const { url } = client.supabaseAuthConfig();
      res.setHeader('Set-Cookie', pkceVerifierCookie(verifier, config.isProduction));
      const authorizeUrl = new URL(`${url}/auth/v1/authorize`);
      authorizeUrl.searchParams.set('provider', 'google');
      authorizeUrl.searchParams.set('redirect_to', redirectTo);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 's256');
      return res.redirect(authorizeUrl.toString());
    }
    if (config.useSupabase && req.path === '/api/auth/google/callback' && req.method === 'GET') {
      const codeVerifier = cookieValue(req, 'calpro_oauth_verifier');
      if (!req.query.code || !/^[A-Za-z0-9_-]{43,128}$/.test(String(codeVerifier || ''))) {
        res.setHeader('Set-Cookie', clearPkceVerifierCookie(config.isProduction));
        return res.status(400).send('Invalid or expired Supabase OAuth callback. Please sign in again.');
      }
      const auth = await client.authExchange(req.query.code, codeVerifier);
      if (!auth.user?.id) return res.status(502).send('Google sign-in did not return a user.');
      const token = sessionToken(auth.user.id); sessions.set(token, auth.user.id);
      await ensureSupabaseSchedulingProfile(client, auth.user);
      res.setHeader('Set-Cookie', [sessionCookie(token), clearPkceVerifierCookie(config.isProduction)]);
      return res.redirect('/');
    }
    if (req.path === '/api/auth/register' && req.method === 'POST') {
      const { email, password, name } = req.body || {};
      if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, and password are required.' });
      const auth = await client.authRequest('signup', { email, password, data: { name } });
      if (auth.user?.id) await ensureSupabaseSchedulingProfile(client, { ...auth.user, email: auth.user.email || email, user_metadata: { ...(auth.user.user_metadata || {}), name } });
      return res.status(201).json({ id: auth.user?.id, email: auth.user?.email || email, name });
    }
    if (req.path === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      const auth = await client.authRequest('token?grant_type=password', { email, password });
      const userId = auth.user?.id;
      if (!userId) return res.status(401).json({ error: 'Invalid email or password.' });
      await ensureSupabaseSchedulingProfile(client, auth.user);
      const token = sessionToken(userId); sessions.set(token, userId);
      res.setHeader('Set-Cookie', sessionCookie(token));
      return res.json({ ok: true, user: { id: userId, email: auth.user.email, name: auth.user.user_metadata?.name || auth.user.email } });
    }
    if (req.path === '/api/auth/logout' && req.method === 'POST') {
      const token = cookieValue(req, 'calpro_session');
      if (token) { sessions.delete(token); revokedSessions.add(token); }
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.json({ ok: true });
    }
    if (req.path === '/api/auth/reset-password' && req.method === 'POST') {
      return res.status(501).json({ error: 'Password reset is unavailable until a verified Supabase recovery flow is configured.' });
    }
    if (req.path === '/api/auth/me' && req.method === 'GET') {
      const userId = currentUser(req); if (!userId) return res.status(401).json({ error: 'Authentication required.' });
      const profile = await client.list('profiles', `?id=eq.${encodeURIComponent(userId)}&select=*`);
      return res.json({ user: { id: userId, email: profile[0]?.email || '', name: profile[0]?.name || '' }, profile: profile[0] || null });
    }
    if (!owner?.id) return res.status(503).json({ error: 'No Supabase scheduling profile is configured.' });
    if (req.path === '/api/profile' && req.method === 'PUT') {
      if (!currentUser(req)) return res.status(401).json({ error: 'Authentication required.' });
      const body = req.body || {};
      const profile = await persistence.updateProfile(currentUser(req), body);
      if (!profile) return res.status(404).json({ error: 'Profile not found.' });
      return res.json(profile);
    }
    if (req.path === '/api/meeting-types' && req.method === 'POST') {
      if (!currentUser(req)) return res.status(401).json({ error: 'Authentication required.' });
      const body = req.body || {};
      const meetingType = await persistence.createMeetingType(currentUser(req), body);
      return res.status(201).json(meetingType);
    }
    if (config.useSupabase && req.path.startsWith('/api/')) {
      const supportedMutation =
        (req.method === 'PUT' && req.path === '/api/availability') ||
        (req.method === 'POST' && req.path === '/api/availability/overrides') ||
        (req.method === 'PATCH' && /^\/api\/availability\/overrides\/[^/]+$/.test(req.path)) ||
        (req.method === 'DELETE' && /^\/api\/availability\/overrides\/[^/]+$/.test(req.path)) ||
        (req.method === 'POST' && /^\/api\/bookings\/[^/]+\/(?:cancel|reschedule)$/.test(req.path)) ||
        (req.method === 'PATCH' && /^\/api\/bookings\/[^/]+$/.test(req.path));
      if (!supportedMutation) return res.status(501).json({ error: 'This operation is not available with Supabase persistence.' });
    }
    next();
  } catch (error) { return res.status(503).json({ error: 'Unable to save data to Supabase.', detail: error.message }); }
});
app.get('/api/state', async (req, res) => { try { const userId = currentUser(req); if (!userId) return res.status(401).json({ error: 'Authentication required.' }); if (config.useSupabase) { const d = await supabaseState.publicState(userId); const profile = await persistence.getProfileByOwner(userId); const meetingTypes = await persistence.listMeetingTypes(userId); const availability = await persistence.getAvailability(userId); const rows = await bookingService.listOwnerBookings(userId); const bookings = rows.map(row => bookingView(row, meetingTypes, availability.schedule?.timezone || profile?.timezone || 'UTC')); return res.json({ ...d, profile: profile || {}, meetingTypes, availability, bookings }); } const d = readData(); const availability = await persistence.getAvailability(userId); const bookings = await bookingService.listOwnerBookings(userId); const safeBookings = bookings.map(row => bookingView(row, d.meetingTypes || [], d.profile?.timezone || 'UTC')); const { bookings: _ignored, ...safeState } = d; res.json({ ...safeState, bookings: safeBookings, availability }); } catch { res.status(503).json({ error: 'Persistence is unavailable.' }); } });
app.get('/api/health', (req, res) => { const d = config.persistenceBackend === 'sqlite' ? readData() : null; res.json({ status: 'ok', service: 'calpro', database: { backend: config.persistenceBackend, status: config.useSupabase ? 'configured' : 'connected' }, googleCalendar: Boolean(d?.integrations?.googleCalendar), timestamp: new Date().toISOString() }); });
app.get('/api/public/:slug', async (req, res) => { try { const result = await persistence.getPublicProfileBySlug(req.params.slug); if (!result) return res.status(404).json({ error: 'Scheduling profile not found.' }); return res.json({ slug: req.params.slug, profile: result.profile, meetingTypes: result.meetingTypes, availability: result.availability, timezone: result.profile.timezone }); } catch (error) { return res.status(503).json({ error: 'Public profile is unavailable.', detail: error.message }); } });
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    if (config.useSupabase) {
      const rows = await bookingService.listOwnerBookings(req.userId);
      const [types, availability, profile] = await Promise.all([persistence.listMeetingTypes(req.userId), persistence.getAvailability(req.userId), persistence.getProfileByOwner(req.userId)]);
      return res.json(rows.map(row => bookingView(row, types, availability.schedule?.timezone || profile?.timezone || 'UTC')));
    }
    const data = readData();
    const profile = await persistence.getProfileByOwner(req.userId), types = await persistence.listMeetingTypes(req.userId), availability = await persistence.getAvailability(req.userId);
    const rows = await bookingService.listOwnerBookings(req.userId);
    return res.json(rows.map(row => bookingView(row, types, availability.schedule?.timezone || profile?.timezone || 'UTC')));
  } catch { return res.status(503).json({ error: 'BOOKING_LIFECYCLE_FAILED' }); }
});
app.get('/api/bookings/:id/guest', async (req, res) => {
  const token = requestManageToken(req);
  const tokenHash = token && hashManageToken(token);
  if (!tokenHash) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
  try {
    if (config.useSupabase) {
      const booking = await bookingService.getGuestBooking(req.params.id, tokenHash);
      return res.json(booking);
    }
    const booking = (readData().bookings || []).find(row => String(row.id) === String(req.params.id) && row.manage_token_hash === tokenHash);
    if (!booking) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
    return res.json({ id: booking.id, status: booking.status, guest_name: booking.name, guest_email: booking.email, guest_timezone: booking.guestTimezone, starts_at: booking.starts_at || null, ends_at: booking.ends_at || null, notes: booking.notes || null, host_timezone: readData().profile?.timezone || 'UTC', meeting_type: { name_en: booking.meetingType, name_ar: '', duration_minutes: 30, mode: '' } });
  } catch (error) { return sendLifecycleError(res, error); }
});
app.post('/api/bookings/:id/guest/cancel', async (req, res) => {
  const token = requestManageToken(req), tokenHash = token && hashManageToken(token);
  const key = operationKey(req.body?.operationKey);
  if (!tokenHash) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
  if (!key) return res.status(400).json({ error: 'INVALID_INPUT' });
  try {
    if (config.useSupabase) {
      const booking = await bookingService.cancelGuestBooking(req.params.id, { manageTokenHash: tokenHash, reason: req.body?.reason, operationKey: key });
      return res.json({ id: booking.id, status: booking.status, cancelledAt: booking.cancelled_at });
    }
    const data = readData(), booking = (data.bookings || []).find(row => String(row.id) === String(req.params.id) && row.manage_token_hash === tokenHash);
    if (!booking) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
    if (booking.status !== 'cancelled') { booking.status = 'cancelled'; booking.cancelled_at = new Date().toISOString(); booking.cancellation_reason = String(req.body?.reason || '').trim() || null; data.booking_history ||= []; data.booking_history.push({ booking_id: booking.id, event_type: 'cancelled', operation_key: key, actor_type: 'guest', old_starts_at: booking.starts_at || null, old_ends_at: booking.ends_at || null, new_starts_at: null, new_ends_at: null, created_at: new Date().toISOString() }); writeData(data); }
    return res.json({ id: booking.id, status: booking.status, cancelledAt: booking.cancelled_at || null });
  } catch (error) { return sendLifecycleError(res, error); }
});
app.post('/api/bookings/:id/guest/reschedule', async (req, res) => {
  const token = requestManageToken(req), tokenHash = token && hashManageToken(token);
  const key = operationKey(req.body?.operationKey);
  if (!tokenHash) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
  if (!key) return res.status(400).json({ error: 'INVALID_INPUT' });
  try {
    let timezone;
    if (config.useSupabase) timezone = (await bookingService.getGuestBooking(req.params.id, tokenHash))?.host_timezone;
    else timezone = readData().profile?.timezone;
    const requestedLocal = normalizedLocalDateTime(req.body?.date, req.body?.time);
    const resolved = timezone && requestedLocal ? resolveLocalWallClock(requestedLocal, timezone) : { status: 'invalid' };
    if (resolved.status !== 'resolved') return res.status(400).json({ error: 'INVALID_LOCAL_TIME' });
    if (config.useSupabase) {
      const booking = await bookingService.rescheduleGuestBooking(req.params.id, { manageTokenHash: tokenHash, requestedLocal, requestedOffsetMinutes: resolved.offsetMinutes, requestedTimezone: timezone, operationKey: key });
      return res.json({ id: booking.id, status: booking.status, starts_at: booking.starts_at, ends_at: booking.ends_at });
    }
    const data = readData(), booking = (data.bookings || []).find(row => String(row.id) === String(req.params.id) && row.manage_token_hash === tokenHash);
    if (!booking) return res.status(403).json({ error: 'INVALID_MANAGE_TOKEN' });
    if (booking.status !== 'confirmed') return res.status(409).json({ error: 'INVALID_BOOKING_STATE' });
    if (bookingOverlaps(data, req.body.date, req.body.time, Number(data.meetingTypes?.find(t => t.id === booking.meetingTypeId)?.duration || 30), booking.id)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    const old = { starts_at: booking.starts_at || `${booking.date}T${booking.time}:00`, ends_at: booking.ends_at || null };
    booking.date = req.body.date; booking.time = req.body.time; booking.starts_at = resolved.instant; booking.status = 'confirmed';
    data.booking_history ||= []; data.booking_history.push({ booking_id: booking.id, event_type: 'rescheduled', operation_key: key, actor_type: 'guest', old_starts_at: old.starts_at, old_ends_at: old.ends_at, new_starts_at: resolved.instant, new_ends_at: null, created_at: new Date().toISOString() }); writeData(data);
    return res.json({ id: booking.id, status: booking.status, starts_at: booking.starts_at, ends_at: booking.ends_at || null });
  } catch (error) { return sendLifecycleError(res, error); }
});
app.get('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    if (config.useSupabase) {
      const booking = await bookingService.getBooking(req.userId, req.params.id);
      if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      const [types, availability, profile] = await Promise.all([persistence.listMeetingTypes(req.userId), persistence.getAvailability(req.userId), persistence.getProfileByOwner(req.userId)]);
      return res.json(bookingView(booking, types, availability.schedule?.timezone || profile?.timezone || 'UTC'));
    }
    const booking = (readData().bookings || []).find(row => String(row.id) === String(req.params.id) && String(row.owner_id) === String(req.userId));
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    const types=await persistence.listMeetingTypes(req.userId), availability=await persistence.getAvailability(req.userId), profile=await persistence.getProfileByOwner(req.userId);
    return res.json(bookingView(booking,types,availability.schedule?.timezone||profile?.timezone||'UTC'));
  } catch { return res.status(503).json({ error: 'BOOKING_LIFECYCLE_FAILED' }); }
});
app.post('/api/bookings/:id/cancel', requireAuth, async (req, res) => {
  const key = operationKey(req.body?.operationKey);
  if (!key) return res.status(400).json({ error: 'INVALID_INPUT' });
  try {
    if (config.useSupabase) {
      const booking = await bookingService.cancelBooking(req.userId, req.params.id, { reason: req.body?.reason, operationKey: key });
      return res.json({ id: booking.id, status: booking.status, cancelledAt: booking.cancelled_at });
    }
    const data = readData(), booking = (data.bookings || []).find(row => String(row.id) === String(req.params.id) && String(row.owner_id) === String(req.userId));
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    if (booking.status !== 'cancelled') { booking.status = 'cancelled'; booking.cancelled_at = new Date().toISOString(); booking.cancellation_reason = String(req.body?.reason || '').trim() || null; writeData(data); }
    return res.json({ id: booking.id, status: booking.status, cancelledAt: booking.cancelled_at || null });
  } catch (error) { return sendLifecycleError(res, error); }
});
app.post('/api/bookings/:id/reschedule', requireAuth, async (req, res) => {
  const key = operationKey(req.body?.operationKey), requestedLocal = normalizedLocalDateTime(req.body?.date, req.body?.time);
  if (!key || !requestedLocal) return res.status(400).json({ error: 'INVALID_INPUT' });
  try {
    if (config.useSupabase) {
      const availability = await persistence.getAvailability(req.userId), timezone = availability.schedule?.timezone;
      const resolved = timezone ? resolveLocalWallClock(requestedLocal, timezone) : { status: 'invalid' };
      if (resolved.status !== 'resolved') return res.status(400).json({ error: 'INVALID_LOCAL_TIME' });
      const booking = await bookingService.rescheduleBooking(req.userId, req.params.id, { requestedLocal, requestedOffsetMinutes: resolved.offsetMinutes, requestedTimezone: timezone, operationKey: key });
      return res.json(bookingView(booking, await persistence.listMeetingTypes(req.userId), timezone));
    }
    const data = readData(), booking = (data.bookings || []).find(row => String(row.id) === String(req.params.id) && String(row.owner_id) === String(req.userId));
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    if (booking.status !== 'confirmed') return res.status(409).json({ error: 'INVALID_BOOKING_STATE' });
    if (bookingOverlaps(data, req.body.date, req.body.time, Number(data.meetingTypes?.find(t => t.id === booking.meetingTypeId)?.duration || 30), booking.id)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    booking.date = req.body.date; booking.time = req.body.time; booking.status = 'confirmed'; writeData(data);
    return res.json(booking);
  } catch (error) { return sendLifecycleError(res, error); }
});
app.post('/api/bookings', async (req, res) => {
  const body = req.body || {};
  const date = String(body.date || '').trim();
  const time = String(body.time || '').trim();
  const profileSlug = String(body.profileSlug || body.profile_slug || '').trim().toLowerCase();
  const meetingTypeId = String(body.meetingTypeId || body.meeting_type_id || '').trim();
  const guestName = String(body.name || body.guestName || '').trim();
  const guestEmail = String(body.email || body.guestEmail || '').trim().toLowerCase();
  const guestTimezone = String(body.guestTimezone || body.guest_timezone || '').trim();
  const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  if (!profileSlug || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !meetingTypeId || !guestName || !guestEmail || !guestTimezone || !idempotencyKey) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  if (config.useSupabase) {
    try {
      const publicState = await persistence.getPublicProfileBySlug(profileSlug);
      if (!publicState) return res.status(404).json({ error: 'INVALID_INPUT' });
      const meetingType = publicState.meetingTypes.find(item => String(item.id) === meetingTypeId || String(item.supabaseId) === meetingTypeId);
      if (!meetingType?.supabaseId) return res.status(404).json({ error: 'INACTIVE_MEETING_TYPE' });
      const hostTimezone = publicState.availability?.schedule?.timezone || publicState.profile.timezone;
      const resolved = resolveLocalWallClock(`${date} ${time}:00`, hostTimezone);
      if (resolved.status !== 'resolved') return res.status(400).json({ error: 'INVALID_LOCAL_TIME' });
      const manageToken = deriveManageToken(idempotencyKey, config.manageTokenSecret);
      const manageTokenHash = hashManageToken(manageToken);
      const booking = await bookingService.createPublicBooking({
        profileSlug,
        meetingTypeId: meetingType.supabaseId,
        requestedLocal: `${date} ${time}:00`,
        requestedOffsetMinutes: resolved.offsetMinutes,
        guestTimezone,
        guestName,
        guestEmail,
        guestPhone: body.phone || body.guestPhone || null,
        notes: body.notes || null,
        idempotencyKey,
        manageTokenHash
      });
      return res.status(201).json(publicBookingResponse(booking, meetingType, hostTimezone, manageToken));
    } catch (error) {
      if (error instanceof BookingValidationError) return res.status(400).json({ error: 'INVALID_INPUT' });
      return sendBookingError(res, error);
    }
  }

  const d = readData();
  const type = (d.meetingTypes || []).find(item => String(item.id) === meetingTypeId);
  if (!type) return res.status(404).json({ error: 'INACTIVE_MEETING_TYPE' });
  if (bookingOutsideRules(d, date, time)) return res.status(409).json({ error: 'BEYOND_BOOKING_HORIZON' });
  if (bookingOverlaps(d, date, time, Number(type.duration || 30))) return res.status(409).json({ error: 'SLOT_TAKEN' });
  const manageToken = deriveManageToken(idempotencyKey, config.manageTokenSecret);
  const manageTokenHash = hashManageToken(manageToken);
  d.bookings ||= [];
  const prior = d.bookings.find(item => item.idempotencyKey === idempotencyKey);
  if (prior) {
    const same = prior.profileSlug === profileSlug && prior.meetingTypeId === meetingTypeId && prior.date === date && prior.time === time && prior.name === guestName && prior.email === guestEmail && prior.guestTimezone === guestTimezone && (prior.manage_token_hash || '') === manageTokenHash;
    if (!same) return res.status(409).json({ error: 'IDEMPOTENCY_CONFLICT' });
    return res.status(200).json({ id: prior.id, name: prior.name, email: prior.email, date: prior.date, time: prior.time, meetingType: prior.meetingType, status: prior.status, createdAt: prior.createdAt, managementUrl: `/manage/${encodeURIComponent(prior.id)}#token=${encodeURIComponent(manageToken)}` });
  }
  const booking = { id: crypto.randomUUID(), owner_id: d.users?.[0]?.id || 'owner', profileSlug, idempotencyKey, name: guestName, email: guestEmail, date, time, meetingTypeId, notes: body.notes || null, guestTimezone, manage_token_hash: manageTokenHash, meetingType: type.en || type.name || 'Meeting', status: 'confirmed', createdAt: new Date().toISOString() };
  d.bookings = d.bookings || [];
  d.bookings.push(booking);
  d.notifications = d.notifications || [];
  d.notifications.push({ id: `booking-${booking.id}`, channel: 'in-app', recipient: 'host', type: 'booking-confirmed', bookingId: booking.id, message: `${booking.name} booked ${booking.meetingType} for ${booking.date} at ${booking.time}.`, status: 'unread', createdAt: booking.createdAt });
  writeData(d);
  let calendarEvent = null;
  let calendarError = null;
  try { calendarEvent = await googleCalendarCreate(d.users?.[0]?.id, booking, type, d.profile?.timezone); } catch (error) { calendarError = error.message; }
  if (calendarEvent) { booking.googleEventId = calendarEvent.id; writeData(d); }
  return res.status(201).json({ id: booking.id, name: booking.name, email: booking.email, date: booking.date, time: booking.time, meetingType: booking.meetingType, status: booking.status, createdAt: booking.createdAt, managementUrl: `/manage/${encodeURIComponent(booking.id)}#token=${encodeURIComponent(manageToken)}`, calendar: calendarEvent ? { status: 'created', eventId: calendarEvent.id, htmlLink: calendarEvent.htmlLink || null } : { status: calendarError ? 'error' : 'not_connected', message: calendarError || 'Google Calendar is not connected.' } });
});
app.get('/api/availability', requireAuth, async (req, res) => { try { res.json(await persistence.getAvailability(req.userId)); } catch (error) { res.status(503).json({ error: 'Availability is unavailable.', detail: error.message }); } });
app.put('/api/availability', requireAuth, async (req, res) => { try { const body = req.body || {}; if (!body.schedule || !Array.isArray(body.intervals)) return res.status(400).json({ error: 'A structured schedule and interval array are required.' }); const normalizedIntervals = normalizeIntervals(body.intervals); const schedule = body.schedule.id ? await persistence.updateAvailabilitySchedule(req.userId, body.schedule.id, body.schedule) : await persistence.createAvailabilitySchedule(req.userId, body.schedule); if (!schedule) return res.status(404).json({ error: 'Availability schedule not found.' }); const result = await persistence.replaceScheduleIntervals(req.userId, schedule.id, normalizedIntervals); if (Array.isArray(body.overrides)) { for (const override of body.overrides) { if (override.id) await persistence.updateAvailabilityOverride(req.userId, override.id, override); else await persistence.createAvailabilityOverride(req.userId, { ...override, scheduleId: schedule.id }); } } return res.json(result || { schedule, intervals: [], overrides: [] }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.get('/api/availability/overrides', requireAuth, async (req, res) => { try { res.json(await persistence.listAvailabilityOverrides(req.userId)); } catch (error) { res.status(503).json({ error: 'Availability overrides are unavailable.', detail: error.message }); } });
app.post('/api/availability/overrides', requireAuth, async (req, res) => { try { const row = await persistence.createAvailabilityOverride(req.userId, req.body || {}); if (!row) return res.status(404).json({ error: 'Availability schedule not found.' }); res.status(201).json(row); } catch (error) { res.status(400).json({ error: error.message }); } });
app.patch('/api/availability/overrides/:id', requireAuth, async (req, res) => { try { const row = await persistence.updateAvailabilityOverride(req.userId, req.params.id, req.body || {}); if (!row) return res.status(404).json({ error: 'Availability override not found.' }); res.json(row); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete('/api/availability/overrides/:id', requireAuth, async (req, res) => { try { const row = await persistence.deleteAvailabilityOverride(req.userId, req.params.id); if (!row) return res.status(404).json({ error: 'Availability override not found.' }); res.json(row); } catch (error) { res.status(503).json({ error: 'Availability override could not be deleted.', detail: error.message }); } });
app.get('/api/availability/slots', async (req, res) => { try { const date = String(req.query.date || ''); const slug = String(req.query.slug || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slug) return res.status(400).json({ error: 'A date and public profile slug are required.' }); const publicState = await persistence.getPublicProfileBySlug(slug); if (!publicState) return res.status(404).json({ error: 'Scheduling profile not found.' }); const timezone = publicState.availability.schedule?.timezone || publicState.profile.timezone; if (!publicState.availability.schedule) return res.json({ date, timezone, slots: [], reason: 'availability-not-configured' }); const day = new Date(`${date}T12:00:00Z`).getUTCDay(); const override = publicState.availability.overrides.find(item => item.overrideDate === date); if (override && !override.isAvailable) return res.json({ date, timezone, slots: [] }); const intervals = override?.isAvailable ? [{ weekday: day, startLocal: override.startLocal, endLocal: override.endLocal }] : publicState.availability.intervals.filter(item => item.weekday === day); const slots = []; for (const interval of intervals) { let minutes = Number(interval.startLocal.slice(0, 2)) * 60 + Number(interval.startLocal.slice(3)); const end = Number(interval.endLocal.slice(0, 2)) * 60 + Number(interval.endLocal.slice(3)); while (minutes < end) { slots.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`); minutes += 30; } } return res.json({ date, timezone, slots: [...new Set(slots)] }); } catch (error) { return res.status(503).json({ error: 'Public availability is unavailable.', detail: error.message }); } });
app.get('/api/meeting-types', async (req, res) => { try { const ownerId = currentUser(req); if (!ownerId) return res.status(401).json({ error: 'Authentication required.' }); return res.json(await persistence.listMeetingTypes(ownerId)); } catch (error) { return res.status(503).json({ error: 'Meeting types are unavailable.', detail: error.message }); } });
app.patch('/api/meeting-types/:id', async (req, res) => { try { const ownerId = currentUser(req); if (!ownerId) return res.status(401).json({ error: 'Authentication required.' }); const result = await persistence.updateMeetingType(ownerId, req.params.id, req.body || {}); if (!result) return res.status(404).json({ error: 'Meeting type not found.' }); return res.json(result); } catch (error) { return res.status(400).json({ error: error.message }); } });
app.delete('/api/meeting-types/:id', async (req, res) => { try { const ownerId = currentUser(req); if (!ownerId) return res.status(401).json({ error: 'Authentication required.' }); const result = await persistence.deactivateMeetingType(ownerId, req.params.id); if (!result) return res.status(404).json({ error: 'Meeting type not found.' }); return res.json(result); } catch (error) { return res.status(503).json({ error: 'Meeting type could not be deactivated.', detail: error.message }); } });
app.get('/api/team', requireAuth, (req, res) => { const d = readData(); res.json(d.teamMembers || []); });
app.post('/api/team/invite', requireAuth, (req, res) => { const d = readData(); const { email, name, role } = req.body || {}; if (!email) return res.status(400).json({ error: 'Email is required.' }); d.teamMembers = d.teamMembers || []; if (d.teamMembers.some(m => m.email === email)) return res.status(409).json({ error: 'This member is already invited.' }); const member = { id: Date.now().toString(), email, name: name || email, role: role || 'member', status: 'invited', invitedAt: new Date().toISOString() }; d.teamMembers.push(member); writeData(d); res.status(201).json(member); });
app.get('/api/notifications', requireAuth, (req, res) => { const d = readData(); res.json((d.notifications || []).slice().reverse()); });
app.post('/api/notifications', requireAuth, (req, res) => { const d = readData(); const { channel, recipient, type, bookingId, message } = req.body || {}; if (!channel || !recipient || !type || !message) return res.status(400).json({ error: 'Channel, recipient, type, and message are required.' }); const item = { id: Date.now().toString(), channel, recipient, type, bookingId: bookingId || null, message, status: 'queued', createdAt: new Date().toISOString() }; d.notifications = d.notifications || []; d.notifications.push(item); writeData(d); res.status(201).json(item); });
app.get('/api/booking-rules', (req, res) => { const d = readData(); res.json(d.bookingRules || { minimumNoticeMinutes: 60, maximumDaysAhead: 60, bufferMinutes: 0 }); });
app.put('/api/booking-rules', requireAuth, (req, res) => { const d = readData(); const body = req.body || {}; d.bookingRules = { minimumNoticeMinutes: Math.max(0, Number(body.minimumNoticeMinutes) || 0), maximumDaysAhead: Math.max(1, Number(body.maximumDaysAhead) || 60), bufferMinutes: Math.max(0, Number(body.bufferMinutes) || 0) }; writeData(d); res.json(d.bookingRules); });
app.post('/api/auth/register', (req, res) => { const d = readData(); const { email, password, name } = req.body || {}; if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, and password are required.' }); if (d.users.some(u => u.email === email)) return res.status(409).json({ error: 'An account with this email already exists.' }); const user = { id: Date.now().toString(), email, password: hashPassword(password), name }; d.users.push(user); writeData(d); res.status(201).json({ id: user.id, email: user.email, name: user.name }); });
app.post('/api/auth/login', (req, res) => { const d = readData(); const { email, password } = req.body || {}; const user = d.users.find(u => u.email === email); if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Invalid email or password.' }); if (!user.password.startsWith('scrypt$')) { user.password = hashPassword(password); writeData(d); } const token = sessionToken(user.id); sessions.set(token, user.id); res.setHeader('Set-Cookie', sessionCookie(token)); res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } }); });
app.post('/api/auth/logout', (req, res) => { const token = cookieValue(req, 'calpro_session'); if (token) { sessions.delete(token); revokedSessions.add(token); } res.setHeader('Set-Cookie', sessionCookie('', 0)); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => { const user = readData().users.find(u => u.id === req.userId); res.json({ user: { id: user.id, email: user.email, name: user.name } }); });
app.get('/api/auth/google', (req, res) => { if (!config.googleClientId) return res.status(503).send('Google OAuth is not configured.'); const params = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: config.googleRedirectUri, response_type: 'code', scope: 'openid email profile https://www.googleapis.com/auth/calendar', access_type: 'offline', prompt: 'consent' }); res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`); });
app.get('/api/auth/google/callback', async (req, res) => { try { if (!req.query.code) return res.status(400).send('Missing Google authorization code.'); const body = querystring.stringify({ code: req.query.code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: config.googleRedirectUri, grant_type: 'authorization_code' }); const token = await httpsRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body); if (token.status >= 400) return res.status(502).send('Google token exchange failed.'); const profile = await httpsRequest('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } }); if (profile.status >= 400) return res.status(502).send('Google profile lookup failed.'); const d = readData(); let user = d.users.find(u => u.email === profile.body.email); if (!user) { user = { id: `google_${Date.now()}`, email: profile.body.email, password: '', name: profile.body.name || profile.body.email }; d.users.push(user); } googleTokens.set(user.id, token.body); db.saveOAuthToken(user.id, 'google', token.body, config.tokenEncryptionKey); d.integrations.googleCalendar = true; d.integrations.googleMeet = true; writeData(d); const session = crypto.randomBytes(32).toString('hex'); sessions.set(session, user.id); res.setHeader('Set-Cookie', sessionCookie(session)); res.redirect('/'); } catch (error) { res.status(502).send(`Google OAuth error: ${error.message}`); } });
app.get('/api/calendar/google/events', requireAuth, async (req, res) => { try { const result = await googleCalendarRequest(req.userId, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50'); if (!result) return res.status(409).json({ error: 'Google Calendar is not connected.' }); if (result.status >= 400) return res.status(502).json({ error: 'Google Calendar request failed.' }); res.json({ events: result.body.items || [] }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.post('/api/calendar/google/events', requireAuth, async (req, res) => { try { const token = googleTokens.get(req.userId); if (!token?.access_token) return res.status(409).json({ error: 'Google Calendar is not connected.' }); const { summary, start, end, timezone } = req.body || {}; if (!summary || !start || !end) return res.status(400).json({ error: 'Summary, start, and end are required.' }); const payload = JSON.stringify({ summary, start: { dateTime: start, timeZone: timezone || 'Asia/Riyadh' }, end: { dateTime: end, timeZone: timezone || 'Asia/Riyadh' }, conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }); const result = await httpsRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload); if (result.status >= 400) return res.status(502).json({ error: 'Google Calendar event creation failed.' }); res.status(201).json({ event: result.body }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.post('/api/bookings/:id/publish-to-google', requireAuth, async (req, res) => { const booking = readData().bookings.find(x => x.id === req.params.id); if (!booking) return res.status(404).json({ error: 'Booking not found.' }); const type = readData().meetingTypes.find(x => x.id === booking.meetingTypeId); const start = `${booking.date}T${booking.time}:00`; const endMinutes = Number(booking.time.slice(0,2)) * 60 + Number(booking.time.slice(3)) + (type?.duration || 30); const end = `${booking.date}T${String(Math.floor(endMinutes/60)).padStart(2,'0')}:${String(endMinutes%60).padStart(2,'0')}:00`; const token = googleTokens.get(req.userId); if (!token?.access_token) return res.status(409).json({ error: 'Google Calendar is not connected.' }); const payload = JSON.stringify({ summary: `${type?.en || 'Meeting'} · ${booking.name}`, description: `Guest email: ${booking.email}`, start: { dateTime: start, timeZone: 'Asia/Riyadh' }, end: { dateTime: end, timeZone: 'Asia/Riyadh' }, conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }); const result = await httpsRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload); if (result.status >= 400) return res.status(502).json({ error: 'Google Calendar event creation failed.' }); res.status(201).json({ bookingId: booking.id, event: result.body }); });
app.get('/api/private/profile', requireAuth, async (req, res) => { try { const profile = await persistence.getProfileByOwner(req.userId); if (!profile) return res.status(404).json({ error: 'Profile not found.' }); res.json({ user: { id: req.userId }, profile }); } catch (error) { res.status(503).json({ error: 'Profile is unavailable.', detail: error.message }); } });
app.post('/api/auth/reset-password', (req, res) => { const d = readData(); const { email, password } = req.body || {}; const user = d.users.find(u => u.email === email); if (!user) return res.status(404).json({ error: 'No account found for this email.' }); if (!password) return res.status(400).json({ error: 'A new password is required.' }); user.password = hashPassword(password); writeData(d); res.json({ ok: true }); });
app.put('/api/profile', requireAuth, async (req, res) => { try { const profile = await persistence.updateProfile(req.userId, req.body || {}); if (!profile) return res.status(404).json({ error: 'Profile not found.' }); res.json(profile); } catch (error) { res.status(400).json({ error: error.message }); } });
app.get('/api/availability/slots', (req, res) => { const d = readData(); const date = String(req.query.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A date in YYYY-MM-DD format is required.' }); const day = new Date(`${date}T12:00:00Z`).getUTCDay(); const dayKey = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][day]; const hours = d.availability[dayKey] || '09:00–18:00'; if (hours === 'مغلق' || dayKey === 'friday' && hours === 'Prayer time protected') return res.json({ date, timezone: d.profile.timezone, slots: [] }); const rules = d.bookingRules || { minimumNoticeMinutes: 60, maximumDaysAhead: 60, bufferMinutes: 0 }; const today = new Date(); const requestedDay = new Date(`${date}T23:59:59`); const daysAhead = Math.ceil((new Date(`${date}T12:00:00`) - new Date(`${today.toISOString().slice(0,10)}T12:00:00`)) / 86400000); if (daysAhead > Number(rules.maximumDaysAhead || 60)) return res.json({ date, day: dayKey, workingHours: hours, timezone: d.profile.timezone, slots: [], reason: 'outside-booking-window' }); const blocked = d.bookings.filter(b => b.status !== 'cancelled' && b.date === date).map(b => { const start = Number(b.time.slice(0,2))*60 + Number(b.time.slice(3)); return [start, start + Number(rules.bufferMinutes || 0)]; }); const slots = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'].filter(t => { const minutes = Number(t.slice(0,2))*60 + Number(t.slice(3)); const slotDate = new Date(`${date}T${t}:00`); const tooSoon = slotDate.getTime() - today.getTime() < Number(rules.minimumNoticeMinutes || 0) * 60000; const conflict = blocked.some(([start,end]) => minutes >= start && minutes <= end); return !tooSoon && !conflict; }); res.json({ date, day: dayKey, workingHours: hours, timezone: d.profile.timezone, slots }); });
app.get('/api/timezone/convert', (req, res) => { const time = String(req.query.time || ''); const from = Number(req.query.from); const to = Number(req.query.to); const m = time.match(/^(\d{1,2}):(\d{2})$/); if (!m || !Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'time, from, and to are required.' }); let minutes = Number(m[1]) * 60 + Number(m[2]) + (to - from) * 60; minutes = (minutes + 1440) % 1440; const h = String(Math.floor(minutes / 60)).padStart(2,'0'); const min = String(minutes % 60).padStart(2,'0'); res.json({ time, converted: `${h}:${min}`, from, to }); });
app.post('/api/integrations/google-calendar', requireAuth, (req, res) => { const d = readData(); d.integrations.googleCalendar = true; d.integrations.googleMeet = true; writeData(d); res.json({ ok: true, integrations: d.integrations }); });
app.post('/api/calendar/sync', requireAuth, (req, res) => { const provider = String(req.body?.provider || '').toLowerCase(); const allowed = ['google', 'outlook', 'apple']; if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unsupported calendar provider.' }); const d = readData(); const key = provider === 'google' ? 'googleCalendar' : provider; d.integrations[key] = true; writeData(d); res.json({ ok: true, provider, syncedAt: new Date().toISOString(), conflicts: d.bookings.length ? 1 : 0 }); });
app.post('/api/meeting-types', requireAuth, async (req, res) => { try { const item = await persistence.createMeetingType(req.userId, req.body || {}); res.status(201).json(item); } catch (error) { res.status(400).json({ error: error.message }); } });
app.get('/api/bookings/:id/ics', requireAuth, async (req, res) => {
  try {
    let booking, timezone, meetingType, hostName;
    if (config.useSupabase) {
      booking = await bookingService.getBooking(req.userId, req.params.id);
      if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      const [profile, types, availability] = await Promise.all([persistence.getProfileByOwner(req.userId), persistence.listMeetingTypes(req.userId), persistence.getAvailability(req.userId)]);
      timezone = availability.schedule?.timezone || profile?.timezone || 'UTC'; hostName = profile?.name || 'Mawaeedy';
      meetingType = types.find(type => String(type.supabaseId || type.id) === String(booking.meeting_type_id));
    } else {
      booking = (readData().bookings || []).find(item => String(item.id) === String(req.params.id) && String(item.owner_id) === String(req.userId));
      if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
      const data = readData(); timezone = data.profile?.timezone || 'UTC'; hostName = data.profile?.name || 'Mawaeedy'; meetingType = (data.meetingTypes || []).find(type => String(type.id) === String(booking.meetingTypeId));
    }
    const start = new Date(booking.starts_at || `${booking.date}T${booking.time}:00Z`), end = new Date(booking.ends_at || start.getTime() + Number(meetingType?.duration || 30) * 60000);
    const utc = value => value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const clean = value => String(value || '').replace(/[\\,;\r\n]/g, ' ');
    const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Mawaeedy//Booking//EN','BEGIN:VEVENT',`UID:${clean(booking.id)}@mawaeedy`,`DTSTAMP:${utc(new Date())}`,`DTSTART:${utc(start)}`,`DTEND:${utc(end)}`,`SUMMARY:${clean(meetingType?.en || booking.meetingType || 'Meeting')}`,`DESCRIPTION:${clean(booking.notes || 'Scheduled with Mawaeedy')}`,`ORGANIZER:CN=${clean(hostName)}`,'END:VEVENT','END:VCALENDAR'].join('\r\n');
    res.setHeader('Content-Type','text/calendar; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="mawaeedy-${encodeURIComponent(booking.id)}.ics"`); return res.send(ics);
  } catch { return res.status(503).json({ error: 'BOOKING_LIFECYCLE_FAILED' }); }
});
app.patch('/api/bookings/:id', requireAuth, async (req, res) => {
  // Compatibility endpoint is deliberately host-only and owner-scoped.
  const key = operationKey(req.body?.operationKey) || crypto.randomUUID();
  if (req.body?.status === 'cancelled') {
    try { const result = config.useSupabase ? await bookingService.cancelBooking(req.userId, req.params.id, { reason: req.body?.reason, operationKey: key }) : null;
      if (config.useSupabase) return res.json(bookingView(result));
      const data=readData(), booking=(data.bookings||[]).find(item=>String(item.id)===String(req.params.id)&&String(item.owner_id)===String(req.userId)); if(!booking)return res.status(404).json({error:'BOOKING_NOT_FOUND'}); if(booking.status!=='cancelled'){booking.status='cancelled';booking.cancelled_at=new Date().toISOString();booking.cancellation_reason=String(req.body?.reason||'').trim()||null;writeData(data)} return res.json(booking);
    } catch(error) { return sendLifecycleError(res,error); }
  }
  if (req.body?.date || req.body?.time) {
    try { const data=readData(); let booking;
      if(config.useSupabase){const availability=await persistence.getAvailability(req.userId),timezone=availability.schedule?.timezone;const local=normalizedLocalDateTime(req.body.date,req.body.time),resolved=local&&timezone?resolveLocalWallClock(local,timezone):{status:'invalid'};if(resolved.status!=='resolved')return res.status(400).json({error:'INVALID_LOCAL_TIME'});booking=await bookingService.rescheduleBooking(req.userId,req.params.id,{requestedLocal:local,requestedOffsetMinutes:resolved.offsetMinutes,requestedTimezone:timezone,operationKey:key});return res.json(bookingView(booking,await persistence.listMeetingTypes(req.userId),timezone))}
      booking=(data.bookings||[]).find(item=>String(item.id)===String(req.params.id)&&String(item.owner_id)===String(req.userId));if(!booking)return res.status(404).json({error:'BOOKING_NOT_FOUND'});if(bookingOverlaps(data,req.body.date,req.body.time,Number(data.meetingTypes?.find(type=>String(type.id)===String(booking.meetingTypeId))?.duration||30),booking.id))return res.status(409).json({error:'SLOT_TAKEN'});booking.date=req.body.date;booking.time=req.body.time;booking.status='confirmed';writeData(data);return res.json(booking);
    } catch(error) { return sendLifecycleError(res,error); }
  }
  return res.status(400).json({error:'INVALID_INPUT'});
});
if (require.main === module) app.listen(PORT, () => console.log(`CalPro running at http://localhost:${PORT}`));
module.exports = app;
module.exports.bookingErrorCategory = bookingErrorCategory;
module.exports.sendBookingError = sendBookingError;

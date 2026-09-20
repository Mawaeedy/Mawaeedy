const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const SQLITE = '/Users/user/Library/Android/sdk/platform-tools/sqlite3';
const DB_FILE = path.join(__dirname, 'calpro.sqlite');
const LEGACY_FILE = path.join(__dirname, 'data.json');

function sql(query) { return execFileSync(SQLITE, [DB_FILE, query], { encoding: 'utf8' }).trim(); }
function init(seed) {
  sql('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL);');
  sql('CREATE TABLE IF NOT EXISTS oauth_tokens (user_id TEXT PRIMARY KEY, provider TEXT NOT NULL, encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL);');
  const exists = sql('SELECT COUNT(*) FROM app_state;');
  if (exists === '0') {
    let initial = seed;
    try { initial = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')); } catch {}
    const json = JSON.stringify(initial).replace(/'/g, "''");
    sql(`INSERT INTO app_state (id, state_json, updated_at) VALUES (1, '${json}', datetime('now'));`);
  }
  normalize(read());
}
function encryptionKey(key) { return crypto.createHash('sha256').update(key).digest(); }
function encryptToken(token, key) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(key), iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]); return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`; }
function decryptToken(value, key) { const [ivHex, tagHex, dataHex] = value.split('.'); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(ivHex, 'hex')); decipher.setAuthTag(Buffer.from(tagHex, 'hex')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')); }
function saveOAuthToken(userId, provider, token, key) { const encrypted = encryptToken(token, key).replace(/'/g, "''"); sql(`INSERT OR REPLACE INTO oauth_tokens VALUES (${q(userId)}, ${q(provider)}, '${encrypted}', datetime('now'));`); }
function getOAuthToken(userId, provider, key) { const row = sql(`SELECT encrypted_token FROM oauth_tokens WHERE user_id = ${q(userId)} AND provider = ${q(provider)};`); return row ? decryptToken(row, key) : null; }
function read() { return JSON.parse(sql("SELECT state_json FROM app_state WHERE id = 1;")); }
function q(value) { return `'${String(value ?? '').replace(/'/g, "''")}'`; }
function normalize(state) {
  sql(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT, name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, title TEXT, location TEXT, bio TEXT, photo TEXT, timezone TEXT); CREATE TABLE IF NOT EXISTS meeting_types (id TEXT PRIMARY KEY, name_ar TEXT, name_en TEXT, duration INTEGER, color TEXT, mode TEXT); CREATE TABLE IF NOT EXISTS availability (user_id TEXT, day TEXT, hours TEXT, PRIMARY KEY(user_id, day)); CREATE TABLE IF NOT EXISTS integrations (user_id TEXT, provider TEXT, connected INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, provider)); CREATE TABLE IF NOT EXISTS notification_preferences (user_id TEXT PRIMARY KEY, channels TEXT); CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, guest_name TEXT, guest_email TEXT, date TEXT, time TEXT, meeting_type_id TEXT, status TEXT, created_at TEXT); CREATE TABLE IF NOT EXISTS team_members (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, role TEXT, status TEXT, invited_at TEXT);`);
  const owner = state.users?.[0] || { id: 'owner', email: 'ahmed@example.com', password: 'demo', name: state.profile?.name || 'Owner' };
  sql(`INSERT OR REPLACE INTO users VALUES (${q(owner.id)}, ${q(owner.email)}, ${q(owner.password)}, ${q(owner.name)}); INSERT OR REPLACE INTO profiles VALUES (${q(owner.id)}, ${q(state.profile?.title)}, ${q(state.profile?.location)}, ${q(state.profile?.bio)}, ${q(state.profile?.photo)}, ${q(state.profile?.timezone)});`);
  for (const t of state.meetingTypes || []) sql(`INSERT OR REPLACE INTO meeting_types VALUES (${q(t.id)}, ${q(t.name)}, ${q(t.en)}, ${Number(t.duration)||30}, ${q(t.color)}, ${q(t.mode)});`);
  for (const [day, hours] of Object.entries(state.availability || {})) { if (!['breaks','ramadan','fridayPrayer','holidays','notifications'].includes(day)) sql(`INSERT OR REPLACE INTO availability VALUES (${q(owner.id)}, ${q(day)}, ${q(hours)});`); }
  for (const [provider, connected] of Object.entries(state.integrations || {})) sql(`INSERT OR REPLACE INTO integrations VALUES (${q(owner.id)}, ${q(provider)}, ${connected ? 1 : 0});`);
  sql(`INSERT OR REPLACE INTO notification_preferences VALUES (${q(owner.id)}, ${q(state.availability?.notifications || 'email,whatsapp')});`);
  for (const b of state.bookings || []) sql(`INSERT OR REPLACE INTO bookings VALUES (${q(b.id)}, ${q(b.name)}, ${q(b.email)}, ${q(b.date)}, ${q(b.time)}, ${q(b.meetingTypeId)}, ${q(b.status)}, ${q(b.createdAt)});`);
  for (const m of state.teamMembers || []) sql(`INSERT OR REPLACE INTO team_members VALUES (${q(m.id)}, ${q(m.email)}, ${q(m.name)}, ${q(m.role)}, ${q(m.status)}, ${q(m.invitedAt)});`);
}
function write(state) { const json = JSON.stringify(state).replace(/'/g, "''"); sql(`UPDATE app_state SET state_json = '${json}', updated_at = datetime('now') WHERE id = 1;`); normalize(state); }
module.exports = { init, read, write, saveOAuthToken, getOAuthToken, DB_FILE };

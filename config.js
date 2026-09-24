const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
function resolvePersistenceBackend(env = process.env) {
  const explicit = env.PERSISTENCE_BACKEND;
  const legacy = env.USE_SUPABASE === 'true' ? 'supabase' : 'sqlite';
  const backend = explicit || legacy;
  if (!['supabase', 'sqlite'].includes(backend)) throw new Error('PERSISTENCE_BACKEND must be either supabase or sqlite.');
  if ((env.NODE_ENV === 'production' || env.VERCEL === '1') && backend !== 'supabase') throw new Error('Production requires PERSISTENCE_BACKEND=supabase.');
  return backend;
}
const persistenceBackend = resolvePersistenceBackend(process.env);
const sessionSecret = process.env.SESSION_SECRET || (!isProduction ? process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || 'local-development-only-change-me' : null);
const tokenEncryptionKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || (!isProduction ? 'local-development-only-change-me' : null);
const manageTokenSecret = process.env.MANAGE_TOKEN_SECRET || (!isProduction ? 'local-development-manage-token-secret-change-me' : null);
if (isProduction && (!sessionSecret || !tokenEncryptionKey || !manageTokenSecret)) throw new Error('SESSION_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY, and MANAGE_TOKEN_SECRET must be configured in production.');
const publicAppUrl = process.env.PUBLIC_APP_URL || null;
module.exports = { googleClientId: process.env.GOOGLE_CLIENT_ID, googleClientSecret: process.env.GOOGLE_CLIENT_SECRET, googleRedirectUri: process.env.GOOGLE_REDIRECT_URI, publicAppUrl, useSupabase: persistenceBackend === 'supabase', persistenceBackend, resolvePersistenceBackend, isProduction, tokenEncryptionKey, sessionSecret, manageTokenSecret };

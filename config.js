const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
module.exports = { googleClientId: process.env.GOOGLE_CLIENT_ID, googleClientSecret: process.env.GOOGLE_CLIENT_SECRET, googleRedirectUri: process.env.GOOGLE_REDIRECT_URI, tokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || 'local-development-only-change-me' };

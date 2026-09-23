const crypto = require('crypto');

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function pkceVerifierCookie(verifier, secure = false) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(verifier || ''))) throw new Error('Invalid OAuth verifier.');
  return `calpro_oauth_verifier=${encodeURIComponent(verifier)}; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=600${secure ? '; Secure' : ''}`;
}

function clearPkceVerifierCookie(secure = false) {
  return `calpro_oauth_verifier=; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = { createPkcePair, pkceVerifierCookie, clearPkceVerifierCookie };

const crypto = require('crypto');

function createSessionToken(userId, secret, now = Date.now()) {
  if (!userId || !secret) throw new Error('A user ID and session secret are required.');
  const payload = `${userId}.${now}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifySessionToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  const [userId, issued, signature] = parts;
  if (!userId || !/^\d+$/.test(issued) || now - Number(issued) > 604800000 || Number(issued) > now + 60000) return null;
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${userId}.${issued}`).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? userId : null;
}

function createSessionCookie(token, maxAge = 604800, secure = false) {
  return `calpro_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { createSessionToken, verifySessionToken, createSessionCookie };

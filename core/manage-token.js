const crypto = require('crypto');

const TOKEN_DOMAIN = 'mawaeedy:booking-manage:v1:';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function deriveManageToken(idempotencyKey, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('MANAGE_TOKEN_SECRET must contain at least 32 bytes.');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new Error('Booking attempt key is invalid.');
  return crypto.createHmac('sha256', secret).update(`${TOKEN_DOMAIN}${idempotencyKey}`, 'utf8').digest('base64url');
}

function hashManageToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { deriveManageToken, hashManageToken, TOKEN_PATTERN };

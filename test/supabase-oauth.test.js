const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createPkcePair, pkceVerifierCookie, clearPkceVerifierCookie } = require('../core/supabase-oauth');
const supabaseClient = require('../supabase/client');
const { buildGoogleCallbackUrl } = require('../core/public-url');
const { createSessionToken, verifySessionToken, createSessionCookie } = require('../core/auth-session');

test('Supabase Google OAuth uses a short-lived HttpOnly PKCE verifier cookie', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.match(pkceVerifierCookie(verifier), /HttpOnly; SameSite=Lax; Path=\/api\/auth\/google\/callback; Max-Age=600/);
  assert.match(pkceVerifierCookie(verifier, true), /; Secure$/);
  assert.doesNotMatch(pkceVerifierCookie(verifier, true), /; Domain=/i);
  assert.match(clearPkceVerifierCookie(), /Max-Age=0/);
  assert.throws(() => pkceVerifierCookie('invalid'));
});

test('Google OAuth authorization and callback bind code exchange to PKCE', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const client = fs.readFileSync('supabase/client.js', 'utf8');
  assert.match(server, /code_challenge_method', 's256'/);
  assert.match(server, /code_challenge', challenge/);
  assert.match(server, /cookieValue\(req, 'calpro_oauth_verifier'\)/);
  assert.match(server, /authExchange\(req\.query\.code, codeVerifier\)/);
  assert.match(client, /token\?grant_type=pkce/);
  assert.match(client, /auth_code: code, code_verifier: codeVerifier/);
  assert.match(server, /supabaseAuthGetPaths = \['\/api\/auth\/google', '\/api\/auth\/google\/callback', '\/api\/auth\/me'\]/);
});

test('production Google OAuth callback uses the canonical HTTPS application origin', () => {
  assert.equal(buildGoogleCallbackUrl({
    publicAppUrl: 'https://mawaeedy.vercel.app/', isProduction: true,
    forwardedProto: 'http', requestProtocol: 'http', host: 'mawaeedy.vercel.app'
  }), 'https://mawaeedy.vercel.app/api/auth/google/callback');
  assert.throws(() => buildGoogleCallbackUrl({
    publicAppUrl: 'http://mawaeedy.vercel.app', isProduction: true,
    requestProtocol: 'http', host: 'mawaeedy.vercel.app'
  }), /must use HTTPS/);
});

test('forwarded HTTPS is honored and local OAuth keeps its localhost callback', () => {
  assert.equal(buildGoogleCallbackUrl({
    isProduction: true, forwardedProto: 'https, http', requestProtocol: 'http', host: 'mawaeedy.vercel.app'
  }), 'https://mawaeedy.vercel.app/api/auth/google/callback');
  assert.equal(buildGoogleCallbackUrl({
    isProduction: false, requestProtocol: 'http', host: 'localhost:4173'
  }), 'http://localhost:4173/api/auth/google/callback');
  assert.throws(() => buildGoogleCallbackUrl({
    isProduction: true, requestProtocol: 'http', host: 'mawaeedy.vercel.app'
  }), /requires an HTTPS/);
});

test('OAuth callback session cookie authenticates statelessly on a later serverless request', () => {
  const now = 1790259000000;
  const secret = 'test-only-session-secret';
  const token = createSessionToken('supabase-user-id', secret, now);
  assert.equal(verifySessionToken(token, secret, now + 1000), 'supabase-user-id');
  assert.equal(verifySessionToken(token, 'different-secret', now + 1000), null);
  assert.equal(verifySessionToken(token, secret, now + 604800001), null);
  assert.equal(verifySessionToken(`supabase-user-id.${now}.${'é'.repeat(64)}`, secret, now), null);
  assert.match(createSessionCookie(token, 604800, true), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure$/);

  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /const token = sessionToken\(auth\.user\.id\); sessions\.set\(token, auth\.user\.id\);/);
  assert.match(server, /res\.setHeader\('Set-Cookie', \[sessionCookie\(token\), clearPkceVerifierCookie\(config\.isProduction\),/);
  assert.match(server, /function currentUser\(req\)[\s\S]*sessions\.get\(token\) \|\| sessionUser\(token\)/);
  assert.match(server, /if \(req\.path === '\/api\/auth\/me' && req\.method === 'GET'\)[\s\S]*currentUser\(req\)/);
});

test('Supabase OAuth exchange sends the authorization code and verifier through PKCE', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ user: { id: 'test-user' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const verifier = createPkcePair().verifier;
    const result = await supabaseClient.authExchange('test-auth-code', verifier);
    assert.equal(result.user.id, 'test-user');
    assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=pkce$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { auth_code: 'test-auth-code', code_verifier: verifier });
  } finally {
    global.fetch = originalFetch;
  }
});

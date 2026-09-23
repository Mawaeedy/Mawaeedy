const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createPkcePair, pkceVerifierCookie, clearPkceVerifierCookie } = require('../core/supabase-oauth');
const supabaseClient = require('../supabase/client');

test('Supabase Google OAuth uses a short-lived HttpOnly PKCE verifier cookie', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.match(pkceVerifierCookie(verifier), /HttpOnly; SameSite=Lax; Path=\/api\/auth\/google\/callback; Max-Age=600/);
  assert.match(pkceVerifierCookie(verifier, true), /; Secure$/);
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

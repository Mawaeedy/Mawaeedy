const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingFailureDiagnostic } = require('../core/booking-diagnostics');

test('public booking diagnostics expose only safe failure metadata', () => {
  const error = new Error('private guest@example.com and token value must not be logged');
  error.supabase = { status: 400, code: 'P0001', message: 'contains guest@example.com' };
  const diagnostic = bookingFailureDiagnostic(error, 'booking-rpc');
  assert.deepEqual(diagnostic, {
    stage: 'booking-rpc', cause: 'SUPABASE_REQUEST_FAILED', supabaseStatus: 400, supabaseCode: 'P0001'
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /guest@example\.com|token value|contains/);
});

test('public booking diagnostics identify a weak management-token secret without revealing it', () => {
  const diagnostic = bookingFailureDiagnostic(
    new Error('MANAGE_TOKEN_SECRET must contain at least 32 bytes.'), 'management-token'
  );
  assert.deepEqual(diagnostic, { stage: 'management-token', cause: 'MANAGE_TOKEN_SECRET_TOO_SHORT' });
});

const SAFE_DATABASE_CODE = /^[A-Z0-9]{5}$/;

function bookingFailureDiagnostic(error, stage) {
  let cause = 'UNCLASSIFIED';
  if (error?.message === 'MANAGE_TOKEN_SECRET must contain at least 32 bytes.') cause = 'MANAGE_TOKEN_SECRET_TOO_SHORT';
  else if (error?.message === 'Booking attempt key is invalid.') cause = 'INVALID_IDEMPOTENCY_KEY';
  else if (error?.message === 'Management credential is invalid.') cause = 'INVALID_MANAGEMENT_CREDENTIAL';
  else if (error?.supabase) cause = 'SUPABASE_REQUEST_FAILED';
  else if (error?.name === 'BookingValidationError') cause = 'INVALID_BOOKING_INPUT';

  const diagnostic = { stage, cause };
  if (Number.isInteger(error?.supabase?.status)) diagnostic.supabaseStatus = error.supabase.status;
  if (SAFE_DATABASE_CODE.test(String(error?.supabase?.code || ''))) diagnostic.supabaseCode = error.supabase.code;
  return diagnostic;
}

module.exports = { bookingFailureDiagnostic };

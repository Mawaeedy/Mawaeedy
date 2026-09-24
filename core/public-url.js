function configuredOrigin(value, isProduction) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_APP_URL must be an absolute HTTP(S) origin.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('PUBLIC_APP_URL must contain only an HTTP(S) origin.');
  }
  if (isProduction && url.protocol !== 'https:') {
    throw new Error('PUBLIC_APP_URL must use HTTPS in production.');
  }
  return url.origin;
}

function buildGoogleCallbackUrl({ publicAppUrl, isProduction = false, forwardedProto, requestProtocol, host }) {
  const origin = configuredOrigin(publicAppUrl, isProduction);
  if (origin) return `${origin}/api/auth/google/callback`;

  const protocol = String(forwardedProto || requestProtocol || '').split(',')[0].trim().toLowerCase();
  if (!['https', 'http'].includes(protocol) || !host) {
    throw new Error('Unable to determine the public application origin for OAuth.');
  }
  if (isProduction && protocol !== 'https') {
    throw new Error('Production OAuth requires an HTTPS public origin.');
  }

  let requestOrigin;
  try {
    requestOrigin = new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new Error('Invalid public host for OAuth callback.');
  }
  return `${requestOrigin}/api/auth/google/callback`;
}

module.exports = { buildGoogleCallbackUrl };

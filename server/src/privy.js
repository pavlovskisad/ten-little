// Privy JWT verification. Validates the access-token the client sends
// in the 'auth' WS message against Privy's JWKS for our app. On
// success, returns the verified Privy user id (the JWT subject); on
// failure, throws.
//
// We cache the remote JWKS using `jose`'s built-in cache. The verify
// path is hot (one call per quickjoin), so re-fetching the JWKS on
// every call would add ~100 ms of avoidable RTT.

const { createRemoteJWKSet, jwtVerify } = require('jose');

const PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'cmp5itgpu000j0dk4zp6r05rs';
const JWKS_URL = `https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`;

let JWKS = null;
function jwks() {
  if (!JWKS) JWKS = createRemoteJWKSet(new URL(JWKS_URL));
  return JWKS;
}

// Returns { userId } on success, throws on failure. Privy access
// tokens are JWTs with the user DID as `sub`, issuer 'privy.io',
// audience = the app id. We assert all three.
async function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('missing token');
  }
  const { payload } = await jwtVerify(token, jwks(), {
    issuer: 'privy.io',
    audience: PRIVY_APP_ID,
  });
  if (!payload.sub) throw new Error('token has no subject');
  return { userId: payload.sub };
}

module.exports = { verifyAccessToken, PRIVY_APP_ID };

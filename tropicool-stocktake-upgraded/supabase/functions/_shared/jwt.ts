// Minimal HS256 JWT signing/verification using the Web Crypto API. No
// external dependency, deliberately -- this mints the session token every
// authenticated request in the app relies on, so it stays small enough to
// read in one sitting rather than trusting an npm package's JWT library.
//
// This implements Supabase's documented "custom JWT" pattern: sign a token
// with the project's JWT secret (Project Settings -> API -> JWT Secret,
// must be set as the SUPABASE_JWT_SECRET env var for this function --
// that's a manual one-time setup step, not something this code can read
// automatically) carrying `role: 'authenticated'` plus whatever custom
// claims you want. PostgREST and Realtime both accept it exactly like a
// GoTrue-issued token, and RLS policies read the custom claims via
// auth.jwt()->>'claim_name'. See ../../AUTH_MODEL.md.

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface SessionClaims {
  staff_id: string;
  store_id: string;
  staff_role: 'staff' | 'manager';
  name: string;
  [key: string]: unknown;
}

const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours -- a working shift, not indefinite

export async function signSessionToken(claims: SessionClaims, jwtSecret: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'authenticated', // required so PostgREST switches from anon -> authenticated
    aud: 'authenticated',
    iat: now,
    exp: expiresAt,
    ...claims,
  };
  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(jwtSecret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = toBase64Url(new Uint8Array(signature));
  return { token: `${signingInput}.${sigB64}`, expiresAt };
}

/** Verifies signature + expiry; throws on any failure. Used by set-staff-pin to authenticate the caller. */
export async function verifySessionToken(token: string, jwtSecret: string): Promise<SessionClaims & { role: string; exp: number }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const key = await hmacKey(jwtSecret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('Token expired');
  return payload;
}

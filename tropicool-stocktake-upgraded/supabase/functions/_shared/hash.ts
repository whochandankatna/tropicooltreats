// PIN hashing using PBKDF2-SHA256 via the Web Crypto API (native to Deno,
// the Supabase Edge Functions runtime) -- no external/npm dependency for
// something this security-sensitive, so there's nothing here to audit
// beyond this file and the platform's own SubtleCrypto implementation.
//
// Important context: a 4-digit PIN has only 10,000 possible values. No hash
// algorithm's cost factor makes that space hard to search once an attacker
// can guess offline (e.g. from a leaked DB dump) -- 210,000 PBKDF2 rounds
// slows that down but doesn't prevent it. The actual defense against
// *online* guessing is the rate limiting/lockout in verify-staff-pin
// (pin_login_attempts + staff.failed_pin_attempts/locked_until). Hashing
// here is defense-in-depth against a raw DB read (backup leak, read
// replica misconfiguration, etc.) exposing usable PINs directly, not the
// primary control.
//
// Stored format: pbkdf2$<iterations>$<salt-base64url>$<hash-base64url>

const ITERATIONS = 210_000; // OWASP-recommended minimum for PBKDF2-SHA256 as of 2024/2025
const SALT_BYTES = 16;
const HASH_BYTES = 32;

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

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(pin, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Constant-time-ish comparison: always derives the full hash before comparing. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const actual = await pbkdf2(pin, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

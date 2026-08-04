/**
 * Browser-side twin of supabase/functions/_shared/hash.ts, kept in sync
 * deliberately (same PBKDF2-SHA256 parameters, same stored format). This
 * file exists ONLY for js/database.js's mock data layer, so the demo/mock
 * "sign in" flow behaves like the real thing while no backend is deployed.
 *
 * Real PIN verification for a live deployment happens server-side, inside
 * the verify-staff-pin Edge Function — never in the browser — because a
 * client-side check can't keep the hash or the comparison result private
 * from someone reading the page's own JavaScript. Once Phase 3's Edge
 * Functions are deployed, js/database.js's verifyStaffPin() swaps from
 * calling the functions in this file to calling that function over HTTP;
 * nothing else in the app needs to change. See AUTH_MODEL.md.
 */

const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pbkdf2(pin, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(pin, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPin(pin, stored) {
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

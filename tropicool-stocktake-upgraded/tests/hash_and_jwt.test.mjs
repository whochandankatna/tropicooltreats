/**
 * Functional tests for the Edge Function crypto helpers
 * (supabase/functions/_shared/hash.ts and jwt.ts).
 *
 * These files target the Deno runtime (Supabase Edge Functions) but use
 * only standard Web Crypto APIs available identically in Node 22, so they
 * can be exercised here directly -- run with:
 *   node --experimental-strip-types --test tests/hash_and_jwt.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin } from '../supabase/functions/_shared/hash.ts';
import { signSessionToken, verifySessionToken } from '../supabase/functions/_shared/jwt.ts';

test('hashPin produces the documented pbkdf2$iterations$salt$hash format', async () => {
  const stored = await hashPin('1234');
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(Number(parts[1]), 210000);
  assert.ok(parts[2].length > 0);
  assert.ok(parts[3].length > 0);
});

test('verifyPin accepts the correct PIN and rejects a wrong one', async () => {
  const stored = await hashPin('4821');
  assert.equal(await verifyPin('4821', stored), true);
  assert.equal(await verifyPin('0000', stored), false);
  assert.equal(await verifyPin('4820', stored), false);
});

test('two hashes of the same PIN are different (random salt) but both verify', async () => {
  const a = await hashPin('1234');
  const b = await hashPin('1234');
  assert.notEqual(a, b);
  assert.equal(await verifyPin('1234', a), true);
  assert.equal(await verifyPin('1234', b), true);
});

test('verifyPin rejects malformed stored values instead of throwing', async () => {
  assert.equal(await verifyPin('1234', 'not-a-real-hash'), false);
  assert.equal(await verifyPin('1234', 'pbkdf2$notanumber$abc$def'), false);
  assert.equal(await verifyPin('1234', ''), false);
});

test('signSessionToken produces a token verifySessionToken accepts, with the right claims', async () => {
  const secret = 'test-jwt-secret-do-not-use-in-real-life';
  const { token, expiresAt } = await signSessionToken(
    { staff_id: 'staff-123', store_id: 'store-abc', staff_role: 'manager', name: 'Bob' },
    secret,
  );
  const claims = await verifySessionToken(token, secret);
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.aud, 'authenticated');
  assert.equal(claims.staff_id, 'staff-123');
  assert.equal(claims.store_id, 'store-abc');
  assert.equal(claims.staff_role, 'manager');
  assert.equal(claims.name, 'Bob');
  assert.equal(claims.exp, expiresAt);
  assert.ok(claims.exp - claims.iat === 8 * 60 * 60, 'session TTL should be 8 hours');
});

test('verifySessionToken rejects a token signed with a different secret', async () => {
  const { token } = await signSessionToken(
    { staff_id: 's1', store_id: 'st1', staff_role: 'staff', name: 'Carl' },
    'secret-one',
  );
  await assert.rejects(() => verifySessionToken(token, 'secret-two'), /Invalid signature/);
});

test('verifySessionToken rejects a tampered payload (role escalation attempt)', async () => {
  const secret = 'test-jwt-secret-do-not-use-in-real-life';
  const { token } = await signSessionToken(
    { staff_id: 's1', store_id: 'st1', staff_role: 'staff', name: 'Carl' },
    secret,
  );
  const [headerB64, payloadB64, sigB64] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  payload.staff_role = 'manager'; // attempted privilege escalation by editing the payload directly
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;
  await assert.rejects(() => verifySessionToken(tamperedToken, secret), /Invalid signature/);
});

test('verifySessionToken rejects an expired token', async () => {
  const secret = 'test-jwt-secret-do-not-use-in-real-life';
  // Manually build an already-expired token using the same signing routine
  // by monkey-patching Date is overkill -- instead assemble one directly.
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'authenticated', aud: 'authenticated',
    iat: Math.floor(Date.now() / 1000) - 100000,
    exp: Math.floor(Date.now() / 1000) - 1, // expired 1 second ago
    staff_id: 's1', store_id: 'st1', staff_role: 'staff', name: 'Carl',
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = Buffer.from(new Uint8Array(sig)).toString('base64url');
  const expiredToken = `${signingInput}.${sigB64}`;
  await assert.rejects(() => verifySessionToken(expiredToken, secret), /expired/);
});

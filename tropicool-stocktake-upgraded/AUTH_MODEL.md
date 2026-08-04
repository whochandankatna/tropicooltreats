# Auth model — Phase 3

Status: **proposed, not deployed**. Migrations `0005`–`0006`; functions
`verify-staff-pin`, `set-staff-pin`. Nothing here is connected to the real
Supabase project. See `AUDIT.md` §13 for what needs your sign-off before it
would be.

## What was wrong before (recap of AUDIT.md §3/§7)

- Staff PINs were fetched to the browser via `select('*')` on `tt_staff`.
- "Manager" access was a JavaScript variable, checked nowhere else.
- Permission checks failed *open* when no PIN had been set yet.
- No rate limiting, no lockout, no logout, no session expiry.
- Sign-off pickers let anyone click any staff member's name.

## The new flow

```
1. Staff opens the app -> picks their store (or the app is pinned to one
   store per device/kiosk) -> enters a 4-digit PIN on the keypad.
2. Client calls verify-staff-pin with { store_id, pin, client_ref }.
   client_ref is a random id generated once and kept in localStorage --
   purely a UX/observability signal, never a security boundary (see the
   function's own comment on why).
3. Edge Function (service_role):
     - rate-limit check by (store_id, ip_hint) -- the real brute-force
       defense, since client_ref is trivially spoofable
     - loads every active staff row at that store with a pin_hash set,
       and checks the entered PIN against each hash (PBKDF2-SHA256,
       210,000 rounds, see _shared/hash.ts)
     - on a match: checks the matched staff's locked_until, then mints an
       8-hour JWT signed with the project's JWT secret, carrying
       { role: 'authenticated', staff_id, store_id, staff_role, name }
     - records the attempt (success or failure) in pin_login_attempts
       either way, for the rate limiter and for audit visibility
4. Client stores the returned access_token (sessionStorage, not
   localStorage -- see "Session storage choice" below) and attaches it to
   every subsequent Supabase call via supabase-js's `accessToken` option
   (see "Client wiring").
5. Every database read/write from then on is subject to the RLS policies
   in 0005_rls_policies.sql, which read staff_id/store_id/staff_role
   straight out of that JWT -- there is no client-side permission check
   left to trust, because none of the ones that mattered were ever
   enforceable client-side to begin with.
6. Session expires after 8 hours (a shift) or on logout (client just
   discards the token -- there's nothing server-side to revoke since it's
   a signed, stateless JWT; see "Early revocation" below for the gap this
   leaves).
```

## Client wiring (for Phase 4, documented now so Phase 3 is reviewable end to end)

Supabase-js v2 supports exactly this "bring your own JWT" pattern via the
`accessToken` option, which is what both PostgREST (table calls) and
Realtime (subscriptions) will use:

```js
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  accessToken: async () => sessionStorage.getItem('tt_session_token') || undefined,
});
```

Before a PIN is entered (or after logout), `accessToken` returns `undefined`
and every request runs as `anon` — which, per the RLS policies, can read
and write nothing (all the app-facing tables revoke `anon` access entirely,
see 0005's grants). This is a meaningful behaviour change from the original
app: previously an un-authenticated session could still read/write via the
anon key if PINs simply hadn't been configured yet (the fail-open bug,
AUDIT.md §7.3); now there is no data access at all without a valid session,
full stop.

## Session storage choice

`sessionStorage`, not `localStorage`: it clears when the tab/browser closes,
which is a reasonable default "logout" for a shared shop device, and limits
how long a stolen/synced token stays usable. A logout button (Phase 4) will
also explicitly clear it and could optionally call a future
`revoke-session` function (see below).

## Early revocation — an accepted, documented gap

A signed JWT is valid until it expires; there's no built-in way to force an
already-issued 8-hour token to stop working early (e.g. immediately after a
manager fires someone or resets their PIN mid-shift). Two mitigations
proposed, neither implemented yet:

1. **Keep the TTL short** (8 hours, one shift) so the exposure window is
   bounded even without revocation.
2. A future `revoke-session` mechanism (a denylist table checked by a
   Postgres function called from RLS, or switching to shorter-lived tokens
   with a refresh step) if you want stronger immediate-revocation
   guarantees than "wait up to 8 hours." Flagging as a deliberate
   trade-off for your input rather than quietly shipping a false sense of
   "instant logout everywhere."

## Rate limiting — what's automatic vs. manual

- **Automatic**: `verify-staff-pin` throttles by `(store_id, ip_hint)` — 8
  failed attempts in 15 minutes blocks further attempts from that
  IP+store for the rest of the window (429 response).
- **Manual**: per-staff `locked_until` (on the `staff` table) is set by a
  manager via `set-staff-pin` (`lock: true`), not auto-populated from
  anonymous failed guesses — because a PIN attempt that matches *no one*
  can't be attributed to a specific staff row to lock. This is a real
  limitation of a shared-keypad, no-username PIN system, not an oversight;
  documented rather than papered over.

## Required manual setup before this could be deployed (not done, needs your approval)

1. Set the `SUPABASE_JWT_SECRET` Edge Function secret to the project's real
   JWT secret (Project Settings → API → JWT Secret) — not auto-injected by
   Supabase the way `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are.
2. Tighten `_shared/cors.ts`'s `Access-Control-Allow-Origin` from the
   current wildcard to the real deployed app origin once that's known.
3. Every existing staff member needs a PIN re-entered through
   `set-staff-pin` (a manager action) rather than migrated in place — see
   `DATA_MODEL.md`'s migration-path section, point 4.
4. Decide on the early-revocation question above before relying on this
   for a large staff roster with turnover.

## Why PBKDF2 instead of bcrypt/argon2, and why hand-rolled JWT instead of a library

Both choices favour *zero external dependencies* for the two most
security-sensitive files in the project, using only the Web Crypto API that
Deno (the Edge Functions runtime) provides natively:

- PBKDF2-SHA256 at 210,000 rounds is OWASP's own current baseline
  recommendation when bcrypt/argon2 aren't conveniently available, and is
  implemented directly via `crypto.subtle` with no package to audit or
  trust.
- The JWT signer/verifier is ~70 lines implementing exactly HS256 sign and
  verify, nothing else (no algorithm confusion surface, no unused
  features) — see `supabase/functions/_shared/jwt.ts`.

Both are covered by real tests, not just written and assumed correct:
`tests/hash_and_jwt.test.mjs` (8 passing) exercises hashing, verification,
wrong-secret rejection, tampered-payload rejection (a simulated privilege
escalation attempt editing `staff_role` in the payload), and expiry.
`tests/sql/` plus the RLS verification run recorded in this phase's commit
exercised the *database* side — store isolation, impersonation blocking,
manager-only approval, and the PIN table being completely unreachable from
any client role — against a real (local, throwaway) Postgres instance with
simulated JWT claims.

// PROPOSED — not deployed. Replaces the original client-side
// saveStaffPinRole() (AUDIT.md §3/§7.1), which wrote whatever the browser
// sent straight into tt_staff.pin with no hashing and no permission check
// beyond a UI toggle. This function:
//   - requires a valid, unexpired session token for a *manager*
//   - hashes the PIN server-side (the client never sends or sees a hash)
//   - can also lock/unlock an account (manager-initiated, see
//     verify-staff-pin's note on why automatic per-staff lockout isn't
//     attempted there)
//
// Request: POST, header Authorization: Bearer <session token from
//          verify-staff-pin>, body:
//   { target_staff_id: uuid, new_pin?: string (4 digits), role?: 'staff'|'manager', lock?: boolean }
// Response: 200 { ok: true } or 200 { ok: false, error }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { hashPin } from '../_shared/hash.ts';
import { verifySessionToken } from '../_shared/jwt.ts';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// TT_JWT_SECRET, not SUPABASE_JWT_SECRET -- see verify-staff-pin/index.ts's
// comment on why (the CLI rejects secret names starting with SUPABASE_).
const JWT_SECRET = Deno.env.get('TT_JWT_SECRET')!;

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, origin);

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let caller;
  try {
    caller = await verifySessionToken(token, JWT_SECRET);
  } catch {
    return json({ ok: false, error: 'Not signed in' }, 401, origin);
  }
  if (caller.staff_role !== 'manager') {
    return json({ ok: false, error: 'Only a manager can change PINs or roles' }, 403, origin);
  }

  let body: { target_staff_id?: string; new_pin?: string; role?: string; lock?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid request body' }, 400, origin);
  }
  const { target_staff_id, new_pin, role, lock } = body;
  if (!target_staff_id) return json({ ok: false, error: 'target_staff_id is required' }, 400, origin);
  if (new_pin && !/^\d{4}$/.test(new_pin)) return json({ ok: false, error: 'PIN must be exactly 4 digits' }, 400, origin);
  if (role && role !== 'staff' && role !== 'manager') return json({ ok: false, error: 'Invalid role' }, 400, origin);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // A manager may only manage staff at their own store — this must be
  // re-checked here, server-side, even though the caller already proved
  // they're a manager: nothing stops a manager JWT for Store A being used
  // (deliberately or via a compromised token) to try to touch Store B's
  // staff, and that must fail regardless of what the caller's own store_id
  // claim says the caller *believes* their store is.
  const { data: target, error: targetError } = await supabase
    .from('staff')
    .select('id, home_store_id')
    .eq('id', target_staff_id)
    .single();
  if (targetError || !target) return json({ ok: false, error: 'Staff member not found' }, 404, origin);
  if (target.home_store_id !== caller.store_id) {
    return json({ ok: false, error: 'You can only manage staff at your own store' }, 403, origin);
  }

  const updates: Record<string, unknown> = {};
  if (new_pin) {
    updates.pin_hash = await hashPin(new_pin);
    updates.pin_set_at = new Date().toISOString();
    updates.failed_pin_attempts = 0;
  }
  if (role) updates.role = role;
  if (lock === true) updates.locked_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  if (lock === false) updates.locked_until = null;

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'Nothing to update' }, 400, origin);
  }

  const { error: updateError } = await supabase.from('staff').update(updates).eq('id', target_staff_id);
  if (updateError) {
    console.error('staff update failed', updateError);
    return json({ ok: false, error: 'Could not save changes' }, 500, origin);
  }

  await supabase.from('audit_log').insert({
    store_id: caller.store_id,
    actor_id: caller.staff_id,
    action: new_pin ? 'staff_pin_reset' : role ? 'staff_role_changed' : lock === true ? 'staff_locked' : 'staff_unlocked',
    entity_type: 'staff',
    entity_id: target_staff_id,
    // Never log the PIN itself, hashed or otherwise -- only that a reset happened.
    after_state: { role: role ?? undefined, pin_changed: !!new_pin, locked: lock },
  });

  return json({ ok: true }, 200, origin);
});

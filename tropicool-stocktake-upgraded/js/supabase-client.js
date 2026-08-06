/**
 * Real-backend Supabase client (AUTH_MODEL.md "Client wiring"). Only
 * imported by database.supabase.js — never by database.mock.js or by any
 * UI module directly, so mock mode never pulls in the vendored SDK bundle
 * at all.
 *
 * This app has no build step, so @supabase/supabase-js is vendored as a
 * single pre-bundled ESM file (js/vendor/supabase-js.esm.js, built with
 * `npm run build:vendor`) rather than imported from a CDN — a CDN import
 * would be a cross-origin request the service worker's same-origin-only
 * fetch handler never precaches, breaking the "app shell loads offline"
 * guarantee Phase 11 tested. Bump the version in package.json and rerun
 * the build script to update it.
 *
 * `accessToken` implements the "bring your own JWT" pattern: before a PIN
 * is entered (or after logout/expiry) sessionStorage has no token, every
 * request runs as `anon`, and per 0005_rls_policies.sql's grants that
 * means no access to anything — not a fallback to read-only or stale data.
 */
import { createClient } from './vendor/supabase-js.esm.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, ACCESS_TOKEN_STORAGE_KEY } from './config.js';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      accessToken: async () => {
        try { return sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || undefined; }
        catch { return undefined; }
      },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

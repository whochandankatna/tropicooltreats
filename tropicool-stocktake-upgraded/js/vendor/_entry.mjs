/**
 * esbuild entry point for regenerating supabase-js.esm.js — not imported by
 * the app itself. Run `npm run build:vendor` after bumping the
 * @supabase/supabase-js version in package.json.
 */
export { createClient } from '@supabase/supabase-js';

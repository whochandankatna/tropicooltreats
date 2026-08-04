// Same-origin-only in production is preferable, but the exact deployed
// origin isn't known at proposal time -- ALLOWED_ORIGIN should be set as an
// Edge Function secret to the real app origin before this goes live, and
// this wildcard tightened. Flagged again in AUTH_MODEL.md.
export function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Bridges Clerk → Supabase.
//
// The Supabase JS client's `accessToken` option calls this function before
// every request. It returns the JWT minted by Clerk's `supabase` template
// (configured in the Clerk dashboard), which Supabase verifies with its
// JWT secret — giving the request the `authenticated` role and populating
// `auth.jwt()` with the claims we need for RLS (`org_id`, `email`, etc).
//
// Why a module-scoped getter and not a React hook:
//   api.js and supabase.js are imported from non-component modules, so
//   they can't use `useAuth()`. AuthContext registers the getter here on
//   sign-in; anyone holding a Supabase client picks it up automatically.

let tokenGetter = null;

/**
 * Register Clerk's token getter. Pass Clerk's `getToken` (from useAuth).
 * Pass `null` on sign-out.
 */
export function setClerkSupabaseTokenGetter(getter) {
  tokenGetter = getter;
}

/**
 * Called by the Supabase client before each request. Returns `null` when
 * no user is signed in — Supabase will send no Authorization header and
 * the request runs as `anon` (which RLS now rejects for private tables).
 */
export async function getClerkSupabaseToken() {
  if (!tokenGetter) return null;
  try {
    return await tokenGetter({ template: 'supabase' });
  } catch {
    return null;
  }
}

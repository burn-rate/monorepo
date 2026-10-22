import { createAuthClient } from 'better-auth/svelte';
import { passkeyClient } from '@better-auth/passkey/client';
import { API_URL } from '$app/env/public';
import { encodePasskeySignupContext } from '@burn-rate/db/auth-context';

export { encodePasskeySignupContext };

/**
 * Better Auth client pointed at the API (the auth server is apps/api, not
 * this app). Cross-origin calls use credentials so the API's session cookie
 * round-trips; the API's CORS config and trustedOrigins must include this
 * app's origin.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [passkeyClient()]
});

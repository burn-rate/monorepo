import { z } from 'zod';

/**
 * Signup form input sent to POST /api/auth/onboarding/context. The endpoint
 * returns an opaque, expiring context for passkey.addPasskey. These form
 * fields alone are not a WebAuthn registration context.
 *
 * The API creates the user only after successful passkey verification and
 * rejects an email already belonging to an account.
 */
export const passkeySignupContextSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100).optional()
});

export type PasskeySignupContext = z.infer<typeof passkeySignupContextSchema>;

/** @deprecated Serializes form input only; obtain the passkey context from the API. */
export function encodePasskeySignupContext(context: PasskeySignupContext): string {
  return JSON.stringify(passkeySignupContextSchema.parse(context));
}

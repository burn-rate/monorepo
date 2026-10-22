import { z } from 'zod';

/**
 * Opaque `context` string passed by the client during passkey-first
 * registration (`authClient.passkey.addPasskey({ context })`). The server
 * parses it in the passkey plugin's `registration.resolveUser` to create the
 * new account.
 *
 * Security note: this context is UNSIGNED. `resolveUser` therefore only ever
 * CREATES users — it rejects contexts claiming an email that already exists,
 * so a passkey can never be attached to someone else's account.
 */
export const passkeySignupContextSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100).optional()
});

export type PasskeySignupContext = z.infer<typeof passkeySignupContextSchema>;

export function encodePasskeySignupContext(context: PasskeySignupContext): string {
  return JSON.stringify(passkeySignupContextSchema.parse(context));
}

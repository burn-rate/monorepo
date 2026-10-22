export interface PasskeySignupInput { email: string; name?: string }

/** Obtain server-owned ceremony state; account creation follows verified WebAuthn. */
export async function requestOnboardingContext(
  apiUrl: string,
  input: PasskeySignupInput,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const response = await fetcher(new URL('/api/auth/onboarding/context', apiUrl), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email.trim().toLowerCase(), name: input.name?.trim() || undefined })
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const detail = error?.error && typeof error.error === 'object' ? error.error as Record<string, unknown> : error;
    throw new Error(typeof detail?.message === 'string' ? detail.message : 'Unable to start passkey registration.');
  }
  if (!body || typeof body !== 'object' || !('context' in body) || typeof body.context !== 'string' || !body.context) {
    throw new Error('The API did not return a passkey registration context.');
  }
  return body.context;
}

import { describe, expect, it, vi } from 'vitest';
import { requestOnboardingContext } from '../src/lib/passkey-onboarding';

describe('passkey signup onboarding', () => {
  it('requests opaque server context with credentials before starting registration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ context: 'server-owned-context', expiresAt: '2026-10-22T00:05:00Z' }));
    const context = await requestOnboardingContext('https://api.burn-rate-app.workers.dev', { email: ' Reader@Example.com ', name: ' Reader ' }, fetcher);
    expect(context).toBe('server-owned-context');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://api.burn-rate-app.workers.dev/api/auth/onboarding/context');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(options!.body as string)).toEqual({ email: 'reader@example.com', name: 'Reader' });
  });

  it('stops signup when onboarding is rejected', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'Try again after one minute.' } }, { status: 429 }));
    await expect(requestOnboardingContext('https://api.example.com', { email: 'reader@example.com' }, fetcher)).rejects.toThrow('Try again after one minute.');
  });

  it('rejects a successful response that omits its opaque context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ email: 'reader@example.com' }));
    await expect(requestOnboardingContext('https://api.example.com', { email: 'reader@example.com' }, fetcher)).rejects.toThrow('did not return');
  });
});

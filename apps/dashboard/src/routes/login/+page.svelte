<svelte:head>
  <title>sign in — burn-rate</title>
</svelte:head>

<script lang="ts">
  import { authClient, requestPasskeySignupContext } from '#lib/auth-client.ts';
  import { API_URL } from '$app/env/public';

  let email = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const session = authClient.useSession();

  /** Turn thrown errors into actionable messages (network vs WebAuthn vs other). */
  function describeFailure(err: unknown, fallback: string): string {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|fetch failed|networkerror|load failed|ERR_CONNECTION/i.test(message)) {
      return `Can't reach the API at ${API_URL} — is apps/api running? (pnpm --filter @burn-rate/api dev)`;
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') return 'Passkey prompt was cancelled or timed out.';
    if (name === 'InvalidStateError') return 'This device already has a passkey for this account.';
    if (name === 'SecurityError') return 'Passkey RP ID / origin mismatch — check PASSKEY_RP_ID config.';
    if (name === 'NotSupportedError') return 'This browser or context does not support passkeys (WebAuthn).';
    return message ? `${fallback}: ${message}` : fallback;
  }

  // The server issues single-use ceremony context. Email/name become an account
  // only after WebAuthn verification, and createSession completes sign-in.
  async function signUpWithPasskey(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    error = null;
    busy = true;
    try {
      const context = await requestPasskeySignupContext({ email, name: name || undefined });
      const { error: authError } = await authClient.passkey.addPasskey({
        context,
        createSession: true
      });
      if (authError) error = authError.message ?? 'Passkey registration failed';
    } catch (err) {
      error = describeFailure(err, 'Passkey registration failed');
    } finally {
      busy = false;
    }
  }

  async function signInWithPasskey() {
    if (busy) return;
    error = null;
    busy = true;
    try {
      const { error: authError } = await authClient.signIn.passkey();
      if (authError) error = authError.message ?? 'Sign-in failed';
    } catch (err) {
      error = describeFailure(err, 'Sign-in failed');
    } finally {
      busy = false;
    }
  }

  async function signOut() {
    busy = true;
    try {
      await authClient.signOut();
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <h1>burn<span class="dash">-</span>rate</h1>

  {#if $session?.data?.user}
    <section class="card">
      <p class="signed-in">
        Signed in as <strong>{$session.data.user.email}</strong>
      </p>
      <button onclick={signOut} disabled={busy}>Sign out</button>
    </section>
  {:else}
    <section class="card">
      <h2>Sign in</h2>
      <p class="hint">Use the passkey registered to your account.</p>
      <button onclick={signInWithPasskey} disabled={busy}>Sign in with passkey</button>
    </section>

    <section class="card">
      <h2>Create account</h2>
      <p class="hint">
        Accounts are passkey-only: enter your email, then your device asks you
        to create a passkey. That passkey is your sign-in.
      </p>
      <form onsubmit={signUpWithPasskey}>
        <label>
          Email
          <input type="email" bind:value={email} required autocomplete="email" />
        </label>
        <label>
          Name <span class="optional">(optional)</span>
          <input type="text" bind:value={name} autocomplete="name" />
        </label>
        <button type="submit" disabled={busy || !email}>Create passkey</button>
      </form>
    </section>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</main>

<style>
  main {
    max-width: 28rem;
    margin: 0 auto;
    padding: var(--space-12) var(--space-6);
    display: grid;
    gap: var(--space-6);
  }

  h1 {
    font-size: var(--text-3xl);
    line-height: var(--leading-tight);
    text-align: center;
    color: var(--color-frosting);
    text-shadow: var(--shadow-sprinkle);
  }

  .dash {
    color: var(--color-sprinkles);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
    display: grid;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .hint,
  .optional {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    margin: 0;
  }

  form {
    display: grid;
    gap: var(--space-3);
  }

  label {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  input {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sprinkle);
    border: 1px solid var(--color-crust-strong);
    background: var(--color-surface);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-base);
  }

  button {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-hole);
    border: none;
    background: var(--color-frosting);
    color: var(--color-on-frosting);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
    justify-self: start;
  }

  button:hover:not(:disabled) {
    background: var(--color-frosting-strong);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .error {
    color: var(--color-danger);
    margin: 0;
  }
</style>

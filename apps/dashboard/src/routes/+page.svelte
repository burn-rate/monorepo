<script lang="ts">
  import { authClient } from '#lib/auth-client.ts';
  import { API_URL } from '$app/env/public';

  const session = authClient.useSession();

  const user = $derived($session?.data?.user ?? null);
  /** This user's personal ingest endpoint; the id attributes stored samples. */
  const ingestUrl = $derived(user ? `${API_URL}/ingest/${user.id}` : null);

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyIngestUrl(): Promise<void> {
    if (!ingestUrl) return;
    await navigator.clipboard.writeText(ingestUrl);
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = false), 2000);
  }
</script>

{#if $session?.isPending}
  <p class="muted">Loading…</p>
{:else if user && ingestUrl}
  <h1>Your ingest URL</h1>
  <p class="lede">
    Point your health exporter here. Everything posted to this URL is stored
    and encrypted against your account ({$session?.data?.user?.email}).
  </p>
  <section class="card">
    <div class="url-row">
      <code class="url">{ingestUrl}</code>
      <button onclick={copyIngestUrl}>{copied ? 'Copied!' : 'Copy'}</button>
    </div>
    <p class="hint">Try it:</p>
    <code class="example">
      curl -X POST -H 'Content-Type: application/json' --data-binary @export.json {ingestUrl}
    </code>
  </section>
{:else}
  <h1>Welcome to burn-rate</h1>
  <section class="card">
    <p class="hint">
      Sign in to get your personal ingest URL — a webhook that stores and
      encrypts every health sample against your account.
    </p>
    <a class="signin" href="/login">Sign in</a>
  </section>
{/if}

<style>
  h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-3xl);
    font-weight: var(--font-bold);
    color: var(--color-frosting);
    text-shadow: var(--shadow-sprinkle);
  }

  .lede {
    margin: 0 0 var(--space-6);
    color: var(--color-text-muted);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
    display: grid;
    gap: var(--space-3);
    justify-items: start;
    max-width: 44rem;
  }

  .hint,
  .muted {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .url-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    width: 100%;
  }

  .url,
  .example {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-sprinkle);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    background: var(--color-glaze);
    color: inherit;
  }

  .url {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
  }

  .example {
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
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
  }

  button:hover:not(:disabled) {
    background: var(--color-frosting-strong);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .signin {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-hole);
    background: var(--color-frosting);
    color: var(--color-on-frosting);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
    justify-self: start;
  }

  .signin:hover {
    background: var(--color-frosting-strong);
  }
</style>

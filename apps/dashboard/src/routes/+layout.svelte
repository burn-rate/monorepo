<script lang="ts">
  import '@burn-rate/design-tokens/css';
  import { authClient } from '#lib/auth-client.ts';

  let { children } = $props();

  const session = authClient.useSession();
  const user = $derived($session?.data?.user ?? null);
  let signingOut = $state(false);

  async function signOut(): Promise<void> {
    if (signingOut) return;
    signingOut = true;
    try {
      await authClient.signOut();
    } finally {
      signingOut = false;
    }
  }
</script>

<header class="topbar">
  <div class="inner">
    <a href="/" class="brand">
      burn<span class="dash">-</span>rate
      <span class="donut" aria-hidden="true"></span>
    </a>
    <nav>
      {#if $session?.isPending}
        <!-- Session still resolving: render nothing rather than flash the wrong CTA. -->
      {:else if user}
        <span class="who">{user.email}</span>
        <button class="signout" onclick={signOut} disabled={signingOut}>
          Sign out
        </button>
      {:else}
        <a href="/login" class="signin">Sign in</a>
      {/if}
    </nav>
  </div>
</header>

<main>
  {@render children()}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
  }

  .topbar {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-crust);
  }

  .inner {
    max-width: 64rem;
    margin: 0 auto;
    padding: var(--space-4) var(--space-6);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .brand {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-frosting);
    text-decoration: none;
  }

  .dash {
    color: var(--color-sprinkles);
  }

  .donut {
    display: inline-block;
    width: 0.875rem;
    height: 0.875rem;
    margin-left: var(--space-2);
    background: var(--color-frosting);
    border: 3px dotted var(--color-sprinkles);
    border-radius: var(--radius-hole);
    vertical-align: -0.1em;
  }

  nav {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .who {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .signin {
    background: var(--color-frosting);
    color: var(--color-on-frosting);
    border-radius: var(--radius-hole);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
  }

  .signin:hover {
    background: var(--color-frosting-strong);
  }

  .signout {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-hole);
    border: 1px solid var(--color-crust-strong);
    background: transparent;
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
  }

  .signout:hover:not(:disabled) {
    background: var(--color-glaze);
  }

  .signout:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  main {
    max-width: 64rem;
    margin: 0 auto;
    padding: var(--space-10) var(--space-6) var(--space-16);
  }
</style>

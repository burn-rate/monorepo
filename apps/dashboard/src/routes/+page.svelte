<svelte:head>
  <title>burn-rate dashboard</title>
  <meta name="description" content="The burn-rate dashboard." />
</svelte:head>

<main>
  <h1>burn<span class="dash">-</span>rate</h1>
  <p>Dashboard starter. Ready to build.</p>
  <p><a href="/login">Sign in</a></p>
</main>

<style>
  main {
    max-width: 64rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
  }

  h1 {
    color: var(--color-frosting);
    text-shadow: var(--shadow-sprinkle);
  }

  .dash {
    color: var(--color-sprinkles);
  }

  p {
    color: var(--color-text-muted);
  }
</style>

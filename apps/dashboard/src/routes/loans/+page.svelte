<svelte:head>
  <title>loans · burn-rate</title>
  <meta name="description" content="Request a treat loan and pay it back by moving." />
</svelte:head>

<script lang="ts">
  import { LOAN_TREAT_IDS } from '@burn-rate/api-schema';
  import LoanCard from '#lib/components/LoanCard.svelte';
  import LoanHistory from '#lib/components/LoanHistory.svelte';

  let historyVersion = $state(0);
</script>

<section class="wrap">
  <h1>loans</h1>
  <p class="hint">Pick a treat, pick a term. Pay it back by moving.</p>
  <p class="hint">Automatic repayment tracking is coming later; new loans start with zero progress.</p>
  <div class="grid">
    {#each LOAN_TREAT_IDS as id (id)}
      <LoanCard treatId={id} onRequested={() => historyVersion++} />
    {/each}
  </div>
  {#key historyVersion}
    <LoanHistory />
  {/key}
</section>

<style>
  .wrap {
    display: grid;
    gap: var(--space-5);
  }

  h1 {
    margin: 0;
    font-size: var(--text-3xl);
    font-weight: var(--font-bold);
    color: var(--color-frosting);
    text-shadow: var(--shadow-sprinkle);
  }

  .hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: var(--space-5);
    align-items: start;
  }
</style>

<script lang="ts">
  import { API_URL } from '$app/env/public';
  import {
    LOAN_TERM_OPTIONS,
    LOAN_TREATS,
    type Loan,
    type CreateLoanInput,
    type LoanTermUnit,
    type LoanTreatId
  } from '@burn-rate/api-schema';
  import { TERM_DAYS, TERM_LABELS, TREAT_ART, requestLoan } from '#lib/loans.ts';

  interface Props {
    treatId: LoanTreatId;
    onRequested?: (loan: Loan) => void;
  }

  let { treatId, onRequested }: Props = $props();

  const treat = $derived(LOAN_TREATS[treatId]);
  const art = $derived(TREAT_ART[treatId]);

  let selectedUnit = $state<LoanTermUnit>('days');
  let requesting = $state(false);
  let loan = $state<Loan | null>(null);
  let error = $state<string | null>(null);
  let artFailed = $state(false);
  let pending: { input: CreateLoanInput; key: string } | null = null;

  async function request(): Promise<void> {
    requesting = true;
    error = null;
    loan = null;
    try {
      const input = {
        amountKcal: treat.caloriesKcal,
        durationDays: TERM_DAYS[selectedUnit],
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      };
      if (!pending || JSON.stringify(pending.input) !== JSON.stringify(input)) {
        pending = { input, key: crypto.randomUUID() };
      }
      const decision = await requestLoan(pending.input, API_URL, pending.key);
      pending = null;
      loan = decision.loan;
      if (decision.outcome === 'approved') onRequested?.(decision.loan);
      else error = decision.message;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Something went wrong';
    } finally {
      requesting = false;
    }
  }

  const dueDate = $derived(loan ? new Date(loan.dueAt).toLocaleDateString() : null);
</script>

<section class="card">
  <header>
    {#if artFailed}
      <span class="art-fallback" aria-hidden="true">{art.emoji}</span>
    {:else}
      <img
        src={art.image}
        alt=""
        width="112"
        height="112"
        loading="lazy"
        onerror={() => (artFailed = true)}
      />
    {/if}
    <div>
      <h2>{treat.name}</h2>
      <p class="kcal">{treat.caloriesKcal} kcal · {treat.serving}</p>
    </div>
  </header>
  <p class="blurb">{art.blurb}</p>

  <div class="terms" role="radiogroup" aria-label="Loan term">
    {#each LOAN_TERM_OPTIONS as option (option.unit)}
      <button
        type="button"
        role="radio"
        aria-checked={selectedUnit === option.unit}
        class:selected={selectedUnit === option.unit}
        onclick={() => (selectedUnit = option.unit)}
        disabled={requesting}
      >
        {TERM_LABELS[option.unit]}
      </button>
    {/each}
  </div>

  <button type="button" class="request" onclick={request} disabled={requesting}>
    {requesting ? 'Requesting…' : 'Request loan'}
  </button>

  {#if loan}
    <p class="result">
      Approved {treat.name} ({loan.principalKcal} kcal), due {dueDate}.
      Repayment target: {loan.repaymentTargetKcal} Move kcal.
    </p>
  {:else if error}
    <p class="error">{error}</p>
  {/if}
</section>

<style>
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
    display: grid;
    gap: var(--space-3);
    justify-items: start;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  img,
  .art-fallback {
    width: 7rem;
    height: 7rem;
    display: grid;
    place-items: center;
    font-size: 5rem;
    line-height: 1;
    background: var(--color-sprinkles-soft);
    border-radius: var(--radius-hole);
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .kcal {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .blurb {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .terms {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .terms button {
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

  .terms button:hover:not(:disabled):not(.selected) {
    background: var(--color-glaze);
  }

  .terms button.selected {
    background: var(--color-sprinkles);
    border-color: var(--color-sprinkles);
    color: var(--color-on-sprinkles);
  }

  .terms button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .request {
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-hole);
    border: none;
    background: var(--color-frosting);
    color: var(--color-on-frosting);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
  }

  .request:hover:not(:disabled) {
    background: var(--color-frosting-strong);
  }

  .request:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .result {
    margin: 0;
    padding: var(--space-3);
    border-radius: var(--radius-sprinkle);
    background: var(--color-sky-soft);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
</style>

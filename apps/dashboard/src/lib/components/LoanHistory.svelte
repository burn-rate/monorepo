<script lang="ts">
  import { onMount } from 'svelte';
  import { API_URL } from '$app/env/public';
  import type { LoanView } from '@burn-rate/api-schema';
  import {
    fetchLoans,
    filterRecentLoans,
    METRIC_LABELS,
    LoansUnavailableError,
    sortLoansForView
  } from '#lib/loans.ts';

  let loans = $state<LoanView[] | null>(null);
  let unavailable = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      loans = sortLoansForView(filterRecentLoans(await fetchLoans(API_URL), new Date()));
    } catch (cause) {
      if (cause instanceof LoansUnavailableError) unavailable = true;
      else error = cause instanceof Error ? cause.message : 'Something went wrong';
    }
  });

  function progressPercent(loan: LoanView): number {
    return Math.min(100, Math.round((loan.repaymentProgressKcal / loan.repaymentTargetKcal) * 100));
  }

  const date = (iso: string): string => new Date(iso).toLocaleDateString();
</script>

<section class="history">
  <h2>Your loans</h2>
  <p class="hint">Active and settled loans from the last 90 days.</p>

  {#if unavailable}
    <p class="empty">Loan history isn't available yet.</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if loans === null}
    <p class="empty">Loading…</p>
  {:else if loans.length === 0}
    <p class="empty">No loans yet — request one above.</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Due</th>
            <th>Repayment</th>
            <th>Outstanding</th>
            <th>Term</th>
          </tr>
        </thead>
        <tbody>
          {#each loans as loan (loan.id)}
            <tr>
              <td><span class="chip {loan.status}">{loan.status}</span></td>
              <td>{date(loan.dueAt)}</td>
              <td>
                <div class="progress">
                  <div class="track">
                    <div class="fill" style:width="{progressPercent(loan)}%"></div>
                  </div>
                  <span class="progress-label">
                    {loan.repaymentProgressKcal} / {loan.repaymentTargetKcal} kcal ·
                    {METRIC_LABELS[loan.repaymentMetric]}
                  </span>
                </div>
              </td>
              <td>{loan.outstandingKcal} kcal</td>
              <td>{loan.durationDays} days</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .history {
    display: grid;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .hint,
  .empty {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: 36rem;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  td {
    padding: var(--space-3);
    border-top: 1px solid var(--color-crust);
    font-size: var(--text-sm);
    vertical-align: middle;
  }

  .chip {
    display: inline-block;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-hole);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }

  .chip.active {
    background: var(--color-sky-soft);
    color: var(--color-sky-strong);
  }

  .chip.repaid {
    background: var(--color-sprinkles-soft);
    color: var(--color-sprinkles-strong);
  }

  .chip.overdue {
    background: var(--color-frosting-soft);
    color: var(--color-danger);
  }

  .progress {
    display: grid;
    gap: var(--space-1);
    min-width: 12rem;
  }

  .track {
    height: 0.375rem;
    background: var(--color-glaze);
    border-radius: var(--radius-hole);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--color-sprinkles);
    border-radius: var(--radius-hole);
  }

  .progress-label {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }
</style>

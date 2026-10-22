<script lang="ts">
  import { onMount } from 'svelte';
  import { API_URL } from '$app/env/public';
  import { CREDIT_SCORE_MAX, CREDIT_SCORE_MIN } from '@burn-rate/api-schema';
  import { fetchScore, scoreFraction } from '#lib/score.ts';

  let score = $state<number | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      score = (await fetchScore(API_URL)).score;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Something went wrong';
    }
  });

  /** A radius of 15.9155 on a 36-unit viewBox makes the circumference 100, so the dasharray is the score fraction directly. */
  const RADIUS = 15.9155;
  const arc = $derived(score === null ? 0 : scoreFraction(score));
  const label = $derived(
    score === null ? 'Credit score unavailable' : `Credit score ${score} of ${CREDIT_SCORE_MAX}`
  );
</script>

<article class="card">
  <span class="chip">credit score</span>
  {#if error}
    <p class="error">{error}</p>
  {:else}
    <div class="donut" role="img" aria-label={label}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="track" cx="18" cy="18" r={RADIUS} />
        <circle class="arc" cx="18" cy="18" r={RADIUS} stroke-dasharray="{arc} 100" />
      </svg>
      <span class="score">{score ?? '—'}</span>
    </div>
    <p class="range">{CREDIT_SCORE_MIN}–{CREDIT_SCORE_MAX}</p>
  {/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
    width: 16rem;
  }

  .chip {
    background: var(--color-sky-soft);
    color: var(--color-sky-strong);
    border-radius: var(--radius-hole);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: capitalize;
  }

  .donut {
    position: relative;
    width: 11rem;
  }

  svg {
    display: block;
    width: 100%;
  }

  circle {
    fill: none;
    stroke-width: 3.6;
  }

  .track {
    stroke: var(--color-glaze);
  }

  .arc {
    stroke: var(--color-frosting);
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: stroke-dasharray 0.6s ease;
  }

  .score {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: var(--text-3xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
  }

  .range {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
</style>

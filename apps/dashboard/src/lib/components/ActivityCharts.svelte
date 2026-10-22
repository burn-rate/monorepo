<script lang="ts">
  import { onMount } from 'svelte';
  import { API_URL } from '$app/env/public';
  import type { HealthSampleDto } from '@burn-rate/api-schema';
  import { bucketSums, fetchMetricSamples, startOfHour, toPoints } from '#lib/metrics.ts';
  import LineChart from '#lib/components/LineChart.svelte';
  import HourlyBars from '#lib/components/HourlyBars.svelte';

  const HOUR_MS = 60 * 60 * 1000;
  const RECENT_MS = 2 * HOUR_MS;
  const WEEK_HOURS = 7 * 24;
  const STAND_BUCKET_MS = 5 * 60 * 1000;
  const STAND_BUCKETS = RECENT_MS / STAND_BUCKET_MS;

  type Status = 'loading' | 'ready' | 'error';

  let status = $state<Status>('loading');
  let errorMessage = $state('');

  let standSamples = $state<HealthSampleDto[]>([]);
  let heartSamples = $state<HealthSampleDto[]>([]);
  let energySamples = $state<HealthSampleDto[]>([]);
  let recentFrom = $state(0);
  let recentTo = $state(0);
  let weekStart = $state(0);

  onMount(async () => {
    const now = Date.now();
    recentFrom = now - RECENT_MS;
    recentTo = now;
    weekStart = startOfHour(new Date(now)) - WEEK_HOURS * HOUR_MS;

    // One failed metric shouldn't blank the other two graphs.
    const [stand, heart, energy] = await Promise.allSettled([
      fetchMetricSamples(API_URL, 'stand_time', new Date(recentFrom), new Date(recentTo)),
      fetchMetricSamples(API_URL, 'heart_rate', new Date(recentFrom), new Date(recentTo)),
      fetchMetricSamples(
        API_URL,
        'active_energy_burned',
        new Date(weekStart),
        new Date(weekStart + WEEK_HOURS * HOUR_MS)
      )
    ]);

    standSamples = stand.status === 'fulfilled' ? stand.value : [];
    heartSamples = heart.status === 'fulfilled' ? heart.value : [];
    energySamples = energy.status === 'fulfilled' ? energy.value : [];
    if (stand.status === 'rejected' && heart.status === 'rejected' && energy.status === 'rejected') {
      status = 'error';
      const cause = stand.reason;
      errorMessage = cause instanceof Error ? cause.message : 'Something went wrong';
      return;
    }
    status = 'ready';
  });

  /** Stand minutes prorated into 5-minute buckets, as chart points. */
  const standPoints = $derived.by(() => {
    const sums = bucketSums(standSamples, { start: recentFrom, bucketMs: STAND_BUCKET_MS, count: STAND_BUCKETS });
    return sums.map((value, i) => ({
      t: recentFrom + i * STAND_BUCKET_MS + STAND_BUCKET_MS / 2,
      value,
      min: null,
      max: null
    }));
  });

  const standTotal = $derived(standPoints.reduce((total, point) => total + point.value, 0));
  const heartPoints = $derived(toPoints(heartSamples));
  const latestHeartRate = $derived(heartPoints.length > 0 ? heartPoints[heartPoints.length - 1].value : null);
  const calorieBuckets = $derived(
    bucketSums(energySamples, { start: weekStart, bucketMs: HOUR_MS, count: WEEK_HOURS })
  );
  const calorieTotal = $derived(calorieBuckets.reduce((total, value) => total + value, 0));

  const round = (value: number): string => String(Math.round(value));
</script>

<section class="activity">
  <h2>Recent activity</h2>

  {#if status === 'loading'}
    <p class="hint">Loading your graphs…</p>
  {:else if status === 'error'}
    <p class="error">{errorMessage}</p>
  {:else}
    <div class="grid">
      <article class="card sprinkles">
        <div class="head">
          <span class="chip">Stand minutes</span>
          {#if standTotal > 0}<span class="stat">{round(standTotal)} min</span>{/if}
        </div>
        {#if standPoints.length === 0}
          <p class="empty">No stand data in the last 2 hours.</p>
        {:else}
          <LineChart
            points={standPoints}
            from={recentFrom}
            to={recentTo}
            accent="var(--color-sprinkles)"
            area
            yFromZero
            unit="min"
            xLabels={['2h ago', 'now']}
            label="Stand minutes over the last two hours, in five-minute buckets"
          />
        {/if}
      </article>

      <article class="card frosting">
        <div class="head">
          <span class="chip">Heart rate</span>
          {#if latestHeartRate !== null}<span class="stat">{round(latestHeartRate)} bpm</span>{/if}
        </div>
        {#if heartPoints.length === 0}
          <p class="empty">No heart rate data in the last 2 hours.</p>
        {:else}
          <LineChart
            points={heartPoints}
            from={recentFrom}
            to={recentTo}
            accent="var(--color-frosting)"
            unit="bpm"
            xLabels={['2h ago', 'now']}
            label="Heart rate over the last two hours, average line with min/max band"
          />
        {/if}
      </article>

      <article class="card sky">
        <div class="head">
          <span class="chip">Active calories</span>
          {#if calorieTotal > 0}<span class="stat">{round(calorieTotal)} kcal</span>{/if}
        </div>
        {#if calorieBuckets.every((value) => value === 0)}
          <p class="empty">No active energy data in the last week.</p>
        {:else}
          <HourlyBars
            values={calorieBuckets}
            start={weekStart}
            bucketMs={HOUR_MS}
            accent="var(--color-sky)"
            unit="kcal"
            label="Active calories per hour over the last seven days"
          />
        {/if}
      </article>
    </div>
  {/if}
</section>

<style>
  .activity {
    margin-top: var(--space-8);
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

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: var(--space-5);
    align-items: start;
  }

  .card {
    display: grid;
    gap: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .chip {
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-hole);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }

  .card.sprinkles {
    --accent: var(--color-sprinkles-strong);
    --accent-soft: var(--color-sprinkles-soft);
  }

  .card.frosting {
    --accent: var(--color-frosting-strong);
    --accent-soft: var(--color-frosting-soft);
  }

  .card.sky {
    --accent: var(--color-sky-strong);
    --accent-soft: var(--color-sky-soft);
  }

  .stat {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-text);
  }
</style>

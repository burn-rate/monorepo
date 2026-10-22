<script lang="ts">
  let {
    values,
    start,
    bucketMs,
    accent,
    unit,
    label
  }: {
    /** One total per bucket, oldest first. */
    values: number[];
    /** Epoch ms of the first bucket's start. */
    start: number;
    bucketMs: number;
    /** CSS color, usually a design-token var() reference. */
    accent: string;
    unit: string;
    label: string;
  } = $props();

  const WIDTH = 336;
  const HEIGHT = 96;
  const TOTAL_HEIGHT = 120;

  const barWidth = $derived(WIDTH / Math.max(values.length, 1));
  const max = $derived(Math.max(...values, 0.0001));

  const bars = $derived(
    values.map((value, i) => {
      const height = (value / max) * HEIGHT;
      return { x: i * barWidth, y: HEIGHT - height, height };
    })
  );

  /** A weekday label wherever a bucket starts a new local day. */
  const dayLabels = $derived.by(() => {
    const labels: { x: number; text: string }[] = [];
    let lastDay: number | null = null;
    values.forEach((_, i) => {
      const at = new Date(start + i * bucketMs);
      if (at.getDate() !== lastDay) {
        labels.push({ x: i * barWidth, text: at.toLocaleDateString(undefined, { weekday: 'short' }) });
        lastDay = at.getDate();
      }
    });
    return labels;
  });

  function fmt(value: number): string {
    return Math.abs(value) >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  }
</script>

<figure role="img" aria-label={label}>
  <svg viewBox="0 0 {WIDTH} {TOTAL_HEIGHT}" style="--chart-accent: {accent}">
    <title>{label}</title>
    {#each bars as bar (bar.x)}
      <rect
        class="bar"
        x={bar.x}
        y={bar.y}
        width={barWidth}
        height={Math.max(bar.height, 0)}
        shape-rendering="crispEdges"
      />
    {/each}
    <line class="baseline" x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} />
    <text class="ymax" x="2" y="10">{fmt(max)} {unit}</text>
    {#each dayLabels as day (day.x)}
      <text class="xlabel" x={day.x + 1} y="116">{day.text}</text>
    {/each}
  </svg>
</figure>

<style>
  figure {
    margin: 0;
  }

  svg {
    display: block;
    width: 100%;
    height: auto;
  }

  .bar {
    fill: var(--chart-accent);
    opacity: 0.85;
  }

  .baseline {
    stroke: var(--color-crust);
    stroke-width: 1;
  }

  text {
    fill: var(--color-text-faint);
    font-family: var(--font-sans);
    font-size: 10px;
  }

  .ymax {
    fill: var(--color-text-muted);
  }
</style>

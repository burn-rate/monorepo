<script lang="ts">
  import type { SamplePoint } from '#lib/metrics.ts';

  let {
    points,
    from,
    to,
    accent,
    area = false,
    yFromZero = false,
    unit,
    xLabels,
    label
  }: {
    points: SamplePoint[];
    /** Fixed x domain (epoch ms) so gaps in the data read as gaps. */
    from: number;
    to: number;
    /** CSS color, usually a design-token var() reference. */
    accent: string;
    area?: boolean;
    yFromZero?: boolean;
    unit: string;
    xLabels: [string, string];
    label: string;
  } = $props();

  const WIDTH = 320;
  const HEIGHT = 96;
  const TOTAL_HEIGHT = 120;

  const x = $derived((t: number): number => ((t - from) / Math.max(to - from, 1)) * WIDTH);

  const scale = $derived.by(() => {
    const values = points.flatMap((point) => [point.value, point.min ?? point.value, point.max ?? point.value]);
    if (values.length === 0) return { min: 0, max: 1 };
    const rawMax = Math.max(...values);
    const rawMin = Math.min(...values);
    const span = Math.max(rawMax - rawMin, rawMax * 0.1, 1);
    if (yFromZero) return { min: 0, max: rawMax + span * 0.15 };
    return { min: Math.max(0, rawMin - span * 0.15), max: rawMax + span * 0.15 };
  });

  const y = $derived((value: number): number => {
    const { min, max } = scale;
    return HEIGHT - ((Math.min(Math.max(value, min), max) - min) / (max - min)) * HEIGHT;
  });

  const linePath = $derived(
    points
      .map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`)
      .join(' ')
  );

  const areaPath = $derived.by(() => {
    if (!area || points.length < 2) return '';
    const first = points[0];
    const last = points[points.length - 1];
    return `${linePath} L${x(last.t).toFixed(1)},${HEIGHT} L${x(first.t).toFixed(1)},${HEIGHT} Z`;
  });

  const bandPath = $derived.by(() => {
    const banded: { t: number; min: number; max: number }[] = [];
    for (const point of points) {
      if (point.min !== null && point.max !== null) banded.push({ t: point.t, min: point.min, max: point.max });
    }
    if (banded.length < 2) return '';
    const upper = banded
      .map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.max).toFixed(1)}`)
      .join(' ');
    const lower = [...banded]
      .reverse()
      .map((point) => `L${x(point.t).toFixed(1)},${y(point.min).toFixed(1)}`)
      .join(' ');
    return `${upper} ${lower} Z`;
  });

  function fmt(value: number): string {
    return Math.abs(value) >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  }
</script>

<figure role="img" aria-label={label}>
  <svg viewBox="0 0 {WIDTH} {TOTAL_HEIGHT}" style="--chart-accent: {accent}">
    <title>{label}</title>
    {#if bandPath}
      <path class="band" d={bandPath} />
    {/if}
    {#if areaPath}
      <path class="area" d={areaPath} />
    {/if}
    {#if linePath}
      <path class="line" d={linePath} />
    {:else if points.length === 1}
      <circle class="dot" cx={x(points[0].t)} cy={y(points[0].value)} r="3" />
    {/if}
    <line class="baseline" x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} />
    <text class="ymax" x="2" y="10">{fmt(scale.max)} {unit}</text>
    <text class="xlabel" x="0" y="116">{xLabels[0]}</text>
    <text class="xlabel end" x={WIDTH} y="116">{xLabels[1]}</text>
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

  .line {
    fill: none;
    stroke: var(--chart-accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .area,
  .band {
    fill: var(--chart-accent);
    stroke: none;
    opacity: 0.16;
  }

  .dot {
    fill: var(--chart-accent);
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

  .xlabel.end {
    text-anchor: end;
  }
</style>

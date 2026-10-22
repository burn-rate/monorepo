<script lang="ts">
  type Tone = 'frosting' | 'sprinkles' | 'sky';

  let {
    label,
    value = '—',
    unit,
    tone = 'sky'
  }: {
    label: string;
    value?: string;
    unit: string;
    tone?: Tone;
  } = $props();
</script>

<article class="card {tone}">
  <span class="chip">{label}</span>
  <p class="value">{value}<span class="unit">{unit}</span></p>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    background: var(--color-surface);
    border: 1px solid var(--color-crust);
    border-radius: var(--radius-doughnut);
    box-shadow: var(--shadow-sprinkle);
    padding: var(--space-5);
  }

  .card.frosting {
    --accent: var(--color-frosting-strong);
    --accent-soft: var(--color-frosting-soft);
  }

  .card.sprinkles {
    --accent: var(--color-sprinkles-strong);
    --accent-soft: var(--color-sprinkles-soft);
  }

  .card.sky {
    --accent: var(--color-sky-strong);
    --accent-soft: var(--color-sky-soft);
  }

  .chip {
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-hole);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: capitalize;
  }

  .value {
    margin: var(--space-4) 0 0;
    font-size: var(--text-3xl);
    font-weight: var(--font-bold);
    line-height: var(--leading-tight);
    color: var(--color-text);
  }

  .unit {
    margin-left: var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--font-normal);
    color: var(--color-text-muted);
  }
</style>

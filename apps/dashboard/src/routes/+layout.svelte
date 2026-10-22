<script lang="ts">
  import '@burn-rate/design-tokens/css';

  let { children } = $props();
</script>

{@render children()}

<style>
  :global(body) {
    margin: 0;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
  }
</style>

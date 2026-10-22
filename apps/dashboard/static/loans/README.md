# Loan art

Cartoon images for the `/loans` page. Until a file exists here, its card shows
an emoji fallback, so the UI works before and after the art lands.

| File | Shows |
| --- | --- |
| `donut.png` | Pink-frosted donut |
| `beer.png` | Frothy pint mug |

## Spec

- Square, 420×420, PNG (WebP also works — update the paths in
  `src/lib/loans.ts` `TREAT_ART`).
- Cartoony, Simpsons-style: thick dark outlines, flat simple shapes,
  slightly exaggerated.
- Palette to match the design tokens (`packages/design-tokens`):
  frosting pink `#ff81c1`, sprinkle yellow `#f8db27`, dough brown `#9c5b01`,
  sky blue `#2f64d6`, on white.

These are served as-is at `/loans/<file>` in the dashboard.

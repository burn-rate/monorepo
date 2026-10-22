/**
 * burn-rate design tokens — Simpsons donut theme.
 *
 * TypeScript mirror of `tokens.css`. Primitives are the five source colors;
 * everything else is derived with `mix()`, which performs the same
 * gamma-encoded sRGB interpolation as CSS `color-mix(in srgb, ...)` so both
 * layers stay in sync. Useful for canvas, charts, and inline styles.
 */

type Rgb = { r: number; g: number; b: number };

/** Source palette. Darker/lighter steps are derived, never hand-picked. */
export const primitives = {
  white: '#ffffff',
  pink: '#ff81c1',
  yellow: '#f8db27',
  brown: '#9c5b01',
  blue: '#2f64d6'
} as const;

function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Mix two hex colors, where `weight` is the fraction of `a` — matching
 * `color-mix(in srgb, a w%, b)` from `tokens.css`.
 */
export function mix(a: string, b: string, weight: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r * weight + cb.r * (1 - weight),
    g: ca.g * weight + cb.g * (1 - weight),
    b: ca.b * weight + cb.b * (1 - weight)
  });
}

/**
 * Shade scale matching tokens.css: 100–400 mix toward white, 600–800 mix
 * toward `darkBase`. `darkBase` is dough (brown) for hues to keep the palette
 * warm, and black for dough itself.
 */
function scale(hex: string, darkBase: string) {
  return {
    100: mix(hex, primitives.white, 0.12),
    200: mix(hex, primitives.white, 0.25),
    300: mix(hex, primitives.white, 0.45),
    400: mix(hex, primitives.white, 0.75),
    500: hex,
    600: mix(hex, darkBase, 0.75),
    700: mix(hex, darkBase, 0.55),
    800: mix(hex, darkBase, 0.35)
  } as const;
}

export type Shade = keyof ReturnType<typeof scale>;

export const shades = {
  pink: scale(primitives.pink, primitives.brown),
  yellow: scale(primitives.yellow, primitives.brown),
  brown: scale(primitives.brown, '#000000'),
  blue: scale(primitives.blue, primitives.brown)
} as const;

/** Donut-metaphor roles, mirroring the semantic layer in tokens.css. */
export const theme = {
  bg: primitives.white,
  surface: primitives.white,
  glaze: shades.yellow[100],
  crust: shades.brown[200],
  crustStrong: shades.brown[300],
  text: shades.brown[700],
  textMuted: shades.brown[500],
  textFaint: shades.brown[300],
  frosting: {
    base: shades.pink[500],
    strong: shades.pink[600],
    soft: shades.pink[100],
    on: shades.brown[700]
  },
  sprinkles: {
    base: shades.yellow[500],
    strong: shades.yellow[600],
    soft: shades.yellow[100],
    on: shades.brown[700]
  },
  sky: {
    base: shades.blue[500],
    strong: shades.blue[600],
    soft: shades.blue[100],
    on: primitives.white
  }
} as const;

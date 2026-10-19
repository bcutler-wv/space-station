import {
  Blend,
  Hct,
  QuantizerCelebi,
  SchemeTonalSpot,
  Score,
  argbFromRgb,
  hexFromArgb,
} from "@material/material-color-utilities";

export const DEFAULT_SEED = argbFromRgb(100, 92, 164);
const ORBIT_BASES = [
  argbFromRgb(0, 143, 153),
  argbFromRgb(181, 66, 83),
  argbFromRgb(110, 93, 198),
  argbFromRgb(165, 111, 12),
];

export function seedFromPixels(rgba: Uint8ClampedArray): number {
  const pixels: number[] = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    pixels.push(argbFromRgb(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0));
  }
  if (!pixels.length) return DEFAULT_SEED;
  const colors = Score.score(QuantizerCelebi.quantize(pixels, 128));
  return colors[0] ?? DEFAULT_SEED;
}

export function themeRoles(
  seed: number,
  dark: boolean,
): Record<string, string> {
  const scheme = new SchemeTonalSpot(Hct.fromInt(seed), dark, 0.2);
  const roles: Record<string, number> = {
    primary: scheme.primary,
    "on-primary": scheme.onPrimary,
    "primary-container": scheme.primaryContainer,
    "on-primary-container": scheme.onPrimaryContainer,
    "secondary-container": scheme.secondaryContainer,
    "on-secondary-container": scheme.onSecondaryContainer,
    tertiary: scheme.tertiary,
    "tertiary-container": scheme.tertiaryContainer,
    "on-tertiary-container": scheme.onTertiaryContainer,
    surface: scheme.surface,
    "surface-container-lowest": scheme.surfaceContainerLowest,
    "surface-container-low": scheme.surfaceContainerLow,
    "surface-container": scheme.surfaceContainer,
    "surface-container-high": scheme.surfaceContainerHigh,
    "surface-container-highest": scheme.surfaceContainerHighest,
    "on-surface": scheme.onSurface,
    "on-surface-variant": scheme.onSurfaceVariant,
    outline: scheme.outline,
    "outline-variant": scheme.outlineVariant,
    error: scheme.error,
    "on-error": scheme.onError,
    "error-container": scheme.errorContainer,
    "on-error-container": scheme.onErrorContainer,
    frame: dark ? scheme.surfaceContainer : scheme.surfaceContainerLow,
    "wall-tint": scheme.surfaceContainerHigh,
    scrim: dark ? scheme.surfaceContainerHighest : scheme.surfaceContainerLow,
    warn: scheme.tertiary,
    ok: scheme.primary,
  };
  ORBIT_BASES.forEach((base, index) => {
    const palette = Hct.fromInt(Blend.harmonize(base, seed));
    palette.tone = dark ? 80 : 40;
    roles[`orbit-${index + 1}`] = palette.toInt();
    palette.tone = dark ? 30 : 90;
    roles[`orbit-${index + 1}-container`] = palette.toInt();
    palette.tone = dark ? 90 : 10;
    roles[`on-orbit-${index + 1}-container`] = palette.toInt();
  });
  return Object.fromEntries(
    Object.entries(roles).map(([name, value]) => [name, hexFromArgb(value)]),
  );
}

export function applyTheme(seed: number, dark: boolean): void {
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  Object.entries(themeRoles(seed, dark)).forEach(([role, value]) =>
    root.style.setProperty(`--${role}`, value),
  );
}

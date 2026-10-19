import { describe, expect, test } from "vitest";
import { DEFAULT_SEED, seedFromPixels, themeRoles } from "./index.js";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}
function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

for (const seed of [DEFAULT_SEED, 0xff006e75, 0xffc43d39, 0xff929200]) {
  for (const dark of [false, true]) {
    test(`normal text role pairs meet AA for ${seed} in ${dark ? "dark" : "light"}`, () => {
      const roles = themeRoles(seed, dark);
      const pairs: [string, string][] = [
        ["primary", "on-primary"],
        ["primary-container", "on-primary-container"],
        ["secondary-container", "on-secondary-container"],
        ["tertiary-container", "on-tertiary-container"],
        ["surface", "on-surface"],
        ["surface-container-low", "on-surface"],
        ["error", "on-error"],
        ["error-container", "on-error-container"],
        ...[1, 2, 3, 4].map((slot): [string, string] => [
          `orbit-${slot}-container`,
          `on-orbit-${slot}-container`,
        ]),
      ];
      for (const [background, foreground] of pairs) {
        expect(
          contrast(roles[background]!, roles[foreground]!),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

describe("wallpaper seed extraction", () => {
  test("uses the fallback for transparent pixels", () => {
    expect(seedFromPixels(new Uint8ClampedArray([12, 35, 250, 0]))).toBe(
      DEFAULT_SEED,
    );
  });
  test("takes a color from visible pixels", () => {
    const pixels = new Uint8ClampedArray(
      Array.from({ length: 50 }, () => [20, 160, 190, 255]).flat(),
    );
    expect(seedFromPixels(pixels)).not.toBe(DEFAULT_SEED);
  });
});

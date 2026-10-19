/* ==========================================================================
   THEME ENGINE (wireframe version)
   Turns one seed color into a full light and dark scheme of tonal roles,
   in the spirit of Material 3. Works in OKLCH so lightness steps look even.

   The production build should swap this for Google's Material Color
   Utilities (Apache 2.0): QuantizerCelebi + Score to pick the seed from the
   wallpaper, SchemeTonalSpot for the roles, Blend.harmonize for Orbit colors.
   The token names below are the contract either way.
   ========================================================================== */
const ThemeEngine = (() => {
  const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function rgbToOklch(r, g, b) {
    r = toLinear(r / 255); g = toLinear(g / 255); b = toLinear(b / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    const C = Math.hypot(A, B);
    let h = Math.atan2(B, A) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h };
  }

  function oklchToRgb(L, C, h) {
    const a = C * Math.cos(h * Math.PI / 180);
    const b = C * Math.sin(h * Math.PI / 180);
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }

  /* Convert to hex, lowering chroma until the color fits in sRGB. */
  function hex(L, C, h) {
    let c = C;
    let rgb = oklchToRgb(L, c, h);
    while (c > 0 && rgb.some(v => v < -0.0001 || v > 1.0001)) {
      c -= 0.002;
      rgb = oklchToRgb(L, c, h);
    }
    return "#" + rgb
      .map(v => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255))
      .map(v => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  /* Nudge a hue up to `max` degrees toward the seed, like M3 harmonize. */
  function harmonize(hue, seedHue, max = 12) {
    const d = ((seedHue - hue + 540) % 360) - 180;
    return (hue + Math.sign(d) * Math.min(Math.abs(d) * 0.5, max) + 360) % 360;
  }

  /* Pick a seed from image pixels: the most common colorful hue. */
  function seedFromPixels(data) {
    const bins = new Array(36).fill(null).map(() => ({ w: 0, c: 0, x: 0, y: 0 }));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const { L, C, h } = rgbToOklch(data[i], data[i + 1], data[i + 2]);
      if (C < 0.03 || L < 0.12 || L > 0.96) continue;
      const bin = bins[Math.floor(h / 10) % 36];
      const w = C * C;
      bin.w += w;
      bin.c += C * w;
      bin.x += Math.cos(h * Math.PI / 180) * w;
      bin.y += Math.sin(h * Math.PI / 180) * w;
    }
    // Score each bin together with its neighbors so hue families win over specks
    let best = -1, bestScore = 0;
    for (let i = 0; i < 36; i++) {
      const score = bins[i].w + 0.5 * (bins[(i + 35) % 36].w + bins[(i + 1) % 36].w);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return { h: 255, c: 0.03 };   // no color in the image: quiet blue-grey
    const b = bins[best];
    let h = Math.atan2(b.y, b.x) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { h, c: b.c / b.w };
  }

  const ORBIT_HUES = { orbit1: 190, orbit2: 25, orbit3: 290, orbit4: 85 };

  /* Build every token for one mode. Values are [lightness, chroma, hue]. */
  function scheme(seed, mode) {
    const h = seed.h;
    const pc = Math.max(0.04, Math.min(seed.c, mode === "dark" ? 0.12 : 0.15));
    const nc = Math.min(0.014, seed.c * 0.12);   // neutral chroma, a faint tint of the seed
    const th = (h + 60) % 360;                    // tertiary hue
    const dark = mode === "dark";

    const roles = dark ? {
      "primary":                   [0.82, pc, h],
      "on-primary":                [0.30, pc * 0.6, h],
      "primary-container":         [0.38, pc * 0.7, h],
      "on-primary-container":      [0.92, pc * 0.4, h],
      "secondary-container":       [0.33, 0.035, h],
      "on-secondary-container":    [0.90, 0.025, h],
      "tertiary":                  [0.82, 0.08, th],
      "tertiary-container":        [0.37, 0.07, th],
      "on-tertiary-container":     [0.92, 0.04, th],
      "surface":                   [0.205, nc, h],
      "surface-container-lowest":  [0.175, nc, h],
      "surface-container-low":     [0.225, nc, h],
      "surface-container":         [0.25, nc, h],
      "surface-container-high":    [0.28, nc, h],
      "surface-container-highest": [0.31, nc, h],
      "on-surface":                [0.93, nc * 0.6, h],
      "on-surface-variant":        [0.78, nc, h],
      "outline":                   [0.62, nc, h],
      "outline-variant":           [0.38, nc, h],
      "error":                     [0.80, 0.11, 25],
      "error-container":           [0.40, 0.10, 25],
      "on-error-container":        [0.92, 0.04, 25],
      "warn":                      [0.83, 0.12, 75],
      "ok":                        [0.80, 0.12, 150]
    } : {
      "primary":                   [0.50, pc, h],
      "on-primary":                [0.99, 0.005, h],
      "primary-container":         [0.90, pc * 0.45, h],
      "on-primary-container":      [0.29, pc * 0.6, h],
      "secondary-container":       [0.91, 0.03, h],
      "on-secondary-container":    [0.30, 0.03, h],
      "tertiary":                  [0.52, 0.10, th],
      "tertiary-container":        [0.91, 0.05, th],
      "on-tertiary-container":     [0.30, 0.06, th],
      "surface":                   [0.985, nc * 0.5, h],
      "surface-container-lowest":  [1.0, 0, h],
      "surface-container-low":     [0.967, nc * 0.6, h],
      "surface-container":         [0.95, nc * 0.7, h],
      "surface-container-high":    [0.933, nc * 0.8, h],
      "surface-container-highest": [0.915, nc, h],
      "on-surface":                [0.22, nc, h],
      "on-surface-variant":        [0.43, nc * 1.4, h],
      "outline":                   [0.58, nc * 1.4, h],
      "outline-variant":           [0.85, nc, h],
      "error":                     [0.52, 0.17, 25],
      "error-container":           [0.92, 0.05, 25],
      "on-error-container":        [0.32, 0.10, 25],
      "warn":                      [0.58, 0.13, 65],
      "ok":                        [0.55, 0.12, 150]
    };

    const out = {};
    for (const [name, [L, C, hue]] of Object.entries(roles)) out[name] = hex(L, C, hue);

    for (const [orbit, baseHue] of Object.entries(ORBIT_HUES)) {
      const oh = harmonize(baseHue, h);
      out[`orbit-${orbit}`] = dark ? hex(0.80, 0.11, oh) : hex(0.55, 0.13, oh);
      out[`orbit-${orbit}-container`] = dark ? hex(0.36, 0.07, oh) : hex(0.91, 0.05, oh);
    }

    // Frame color and the tint laid over the wallpaper (8-digit hex for alpha)
    out["frame"] = dark ? out["surface-container-lowest"] : out["surface-container"];
    out["wall-tint"] = out["surface"] + (dark ? "8C" : "73");
    out["scrim"] = hex(0.1, nc, h) + "73";
    return out;
  }

  return { scheme, seedFromPixels, hex, rgbToOklch };
})();
if (typeof module !== "undefined") module.exports = ThemeEngine;

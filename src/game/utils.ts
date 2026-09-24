/**
 * ============================================================================
 *  utils.ts — Small shared helpers (seeded RNG, math).
 * ============================================================================
 */

/**
 * Deployment base path (GitHub Pages serves this site under /Googlecalendar/).
 * Empty in local dev, "/Googlecalendar" in Pages builds — set at build time
 * via NEXT_PUBLIC_BASE_PATH, which Next inlines into the client bundle.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH as string | undefined) ?? '';

/** Prefix a public asset path (/textures/…, /audio/…) with the base path. */
export function asset(path: string): string {
  return BASE_PATH + path;
}

/**
 * Mulberry32 — tiny, fast, seeded pseudo-random generator.
 * Using a seeded RNG means a maze can be reproduced from a single number
 * (handy for debugging or sharing "the same maze" between players).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] (inclusive). */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Clamp a value between lo and hi. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate-independent exponential smoothing (a.k.a. damp / eLerp).
 * `lambda` = smoothing speed; higher reaches the target faster.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Format milliseconds as m:ss for the death screen. */
export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

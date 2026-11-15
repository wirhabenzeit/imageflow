// A hidden window's capture can return an older compositor frame than the DOM it was asked for: after heavy GPU work,
// such as large WebGL maps, it has returned the book's own layout (its first spread) in place of the artwork that had
// replaced it, and a blank surface for a contact sheet. The artwork view therefore paints a small strip of colours
// chosen for each capture just below the artwork, in the same frame, and the capture includes it: pixels without that
// strip were not composited after the artwork was placed, so they are retried or rejected, never returned.

export type Rgb = readonly [number, number, number];
export type Sentinel = { first: Rgb; second: Rgb };

// Cells of the strip, left to right: first, second, first. Each is cellWidth × height CSS pixels.
export const sentinelStrip = { cellWidth: 8, height: 4, cells: 3 } as const;
export const sentinelWidth = sentinelStrip.cellWidth * sentinelStrip.cells;

const hex = (rgb: Rgb) => rgb.map((value) => value.toString(16).padStart(2, '0')).join('');

/** Two colours far apart on every channel, so neither a white, grey nor stale page can pass for the pattern. */
export function makeSentinel(random: () => number = Math.random): Sentinel {
  const channel = () => { const value = 40 + Math.floor(random() * 60); return random() < 0.5 ? value : 255 - value; };
  const first: Rgb = [channel(), channel(), channel()];
  return { first, second: first.map((value) => 255 - value) as unknown as Rgb };
}

export const formatSentinel = ({ first, second }: Sentinel) => hex(first) + '-' + hex(second);

export function parseSentinel(value: string | null): Sentinel | undefined {
  const match = value && /^([0-9a-f]{6})-([0-9a-f]{6})$/.exec(value);
  if (!match) return undefined;
  const rgb = (text: string): Rgb => [0, 2, 4].map((i) => parseInt(text.slice(i, i + 2), 16)) as unknown as Rgb;
  return { first: rgb(match[1]), second: rgb(match[2]) };
}

/** Centres of the cells, in CSS pixels, for a strip whose top edge is at `top`. */
export function sentinelSamples(top: number) {
  return Array.from({ length: sentinelStrip.cells }, (_, i) => ({ x: i * sentinelStrip.cellWidth + sentinelStrip.cellWidth / 2, y: top + sentinelStrip.height / 2 }));
}

/**
 * Whether sampled cells show the strip. Colour management may shift the values a little, so this compares the
 * pattern rather than exact values: both first cells alike, close to the colour asked for, and on every channel the
 * second cell on the far side of the first.
 */
export function sentinelMatches(samples: readonly Rgb[], { first, second }: Sentinel) {
  if (samples.length !== sentinelStrip.cells) return false;
  const [a, b, c] = samples;
  const near = (x: Rgb, y: Rgb, tolerance: number) => x.every((value, i) => Math.abs(value - y[i]) <= tolerance);
  return near(a, c, 24) && near(a, first, 64) && near(b, second, 64) &&
    a.every((value, i) => Math.sign(value - b[i]) === Math.sign(first[i] - second[i]) && Math.abs(value - b[i]) >= 40);
}

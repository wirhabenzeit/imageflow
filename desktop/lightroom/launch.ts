import { execFile } from 'node:child_process';

/** Runs a program with arguments, never through a shell. */
export type Runner = (file: string, args: readonly string[]) => Promise<void>;
const run: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 30_000 }, (error) => { if (error) reject(error); else resolve(); });
});

/** The application name `open -a` finds Lightroom Classic by. */
export const lightroomApplication = 'Adobe Lightroom Classic';

/**
 * Opens Lightroom Classic for photos that are offline because it is not running (the `launch` repair, ADR 0011,
 * §4.4). The plugin starts with it and connects by itself; the provider's watch then reports every photo, and the book
 * observes them again. A Lightroom that runs already is only brought to the front.
 */
export async function launchLightroom(runner: Runner = run) {
  try { await runner('/usr/bin/open', ['-a', lightroomApplication]); }
  catch { throw new Error('Lightroom Classic was not found on this Mac. Open it yourself, with the ImageFlow plugin installed.'); }
}

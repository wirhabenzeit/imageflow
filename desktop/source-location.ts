import { SourceMap } from 'node:module';
import { posix } from 'node:path';
import type { OpenProject } from './project';

export type SourceLocation = { path: string; line: number; column: number };

/** The template source location of the first stack frame inside the bundled template, using its esbuild source map.
 * Frames in ImageFlow's runtime, React or host modules are skipped, so the location is the template code that called
 * them. Returns undefined when no frame maps to a file inside template/. */
export function templateLocation(stack: string | undefined, book: Pick<OpenProject, 'assets'> | undefined): SourceLocation | undefined {
  const map = book?.assets.files.get('template.js.map');
  if (!stack || !map) return undefined;
  let sourceMap: SourceMap;
  try { sourceMap = new SourceMap(JSON.parse(Buffer.from(map).toString('utf8'))); }
  catch { return undefined; }
  for (const frame of stack.matchAll(/\/template\/template\.js:(\d+):(\d+)/g)) {
    const entry = sourceMap.findEntry(Number(frame[1]) - 1, Number(frame[2]) - 1) as Partial<{ originalSource: string; originalLine: number; originalColumn: number }>;
    if (!entry.originalSource || entry.originalLine === undefined || entry.originalColumn === undefined) continue;
    // esbuild names sources relative to the bundle, which sits in template/.
    const source = entry.originalSource.replace(/^file:\/\//, '');
    if (source.includes(':') || posix.isAbsolute(source)) continue;
    const path = posix.normalize(posix.join('template', source));
    if (!path.startsWith('template/')) continue;
    return { path, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
  }
  return undefined;
}

import { createHash } from 'node:crypto';
import type { Metafile } from 'esbuild';

// A drawn picture (<RenderedImage>) is cached by its draw function's source, its inputs and its size. Helpers that
// `draw` calls from other files are not in its source, so the cache is also scoped: by the file that places the
// picture together with everything that file imports, transitively. An edit elsewhere in the template, such as a
// layout in index.tsx or the stylesheet, keeps a map drawn from map.tsx cached; an edit to map.tsx, its styles module
// or the map package draws it again. Checks and exports always draw afresh, so a scope only ever decides what the
// editor shows from its cache.
//
// Stylesheets, and files only they reference (fonts, background images), are left out: SVG pictures are styled by
// the page's CSS where they are placed, so a stylesheet edit never needs a new drawing. (A raster picture that reads
// computed styles or draws text in a template font while drawing is not drawn again for a stylesheet edit.)

/** The host module that a template file imports `imageflow` through, which tells its pictures their file. */
export const scopedRuntimePrefix = 'imageflow?';

const leftOut = (path: string) => path.endsWith('.css') || path.startsWith('imageflow-host:');

/**
 * The scope of each template file that imports `imageflow` (by its path relative to template/): a hash of the file and
 * everything it imports, without stylesheets. `content` reads an input's bytes as the bundle saw them.
 */
export async function pictureScopes(metafile: Metafile, content: (input: string) => Promise<string | Uint8Array | undefined>) {
  const inputs = metafile.inputs;
  const hashes = new Map<string, string>();
  const hashOf = async (input: string) => {
    if (!hashes.has(input)) {
      const bytes = await content(input);
      hashes.set(input, createHash('sha256').update(bytes ?? '\0missing').digest('hex'));
    }
    return hashes.get(input)!;
  };
  const scopes: Record<string, string> = {};
  for (const [input, { imports }] of Object.entries(inputs)) {
    if (!imports.some(({ path }) => path === 'imageflow-host:' + scopedRuntimePrefix + input)) continue;
    const reached = new Set<string>();
    const visit = (path: string) => {
      if (reached.has(path) || leftOut(path) || !inputs[path]) return;
      reached.add(path);
      for (const next of inputs[path].imports) visit(next.path);
    };
    visit(input);
    const hash = createHash('sha256').update('imageflow-picture-scope-1\n');
    for (const path of [...reached].sort()) hash.update(JSON.stringify([path, await hashOf(path)]) + '\n');
    scopes[input] = hash.digest('hex');
  }
  return scopes;
}

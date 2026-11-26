import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildMcp(destination = join(root, '.build', 'mcp-bridge.cjs')) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await mkdir(dirname(destination), { recursive: true });
  await build({
    entryPoints: [join(root, 'desktop', 'mcp-bridge.ts')], outfile: destination,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning',
    // The app's version: the bridge tells a newer app which one it was started from (#232).
    define: { __IMAGEFLOW_VERSION__: JSON.stringify(version) },
  });
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildMcp(process.argv[2]);

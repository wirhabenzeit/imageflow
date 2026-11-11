import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildMcp(destination = join(root, '.build', 'mcp-bridge.cjs')) {
  await mkdir(dirname(destination), { recursive: true });
  await build({
    entryPoints: [join(root, 'desktop', 'mcp-bridge.ts')], outfile: destination,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning',
  });
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildMcp(process.argv[2]);

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// The runtime and standalone templates share this canonical SDK; snapshots are build output, never copied by hand.
const result = await build({ entryPoints: ['desktop/authoring-sdk.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { writeAuthoringSnapshot } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const types = await mkdtemp(join(tmpdir(), 'imageflow-sdk-'));
try {
  await cp('authoring', types, { recursive: true });
  await cp('node_modules/@types/react', join(types, 'react-runtime'), { recursive: true });
  await cp('node_modules/csstype', join(types, 'csstype'), { recursive: true });
  for (const name of ['starter', 'calendar']) {
    const template = join('sample', name, 'template');
    await mkdir(template, { recursive: true });
    await writeAuthoringSnapshot(template, types);
  }
} finally { await rm(types, { recursive: true, force: true }); }

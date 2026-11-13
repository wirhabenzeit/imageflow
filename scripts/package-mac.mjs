import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };
import metadata from '../package.json' with { type: 'json' };
import { esbuildBinary, sample, stageDesktop } from './stage-desktop.mjs';
import { macBuildOptions } from './mac-build-options.mjs';
import { verifyMacSigning } from './verify-mac-signing.mjs';
import { notarizeMacRelease } from './mac-release-artifacts.mjs';

if (process.platform !== 'darwin') throw new Error('Run the macOS build on a Mac.');

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { release: { type: 'boolean', default: false }, arch: { type: 'string' } } });
const options = macBuildOptions({ arch: values.arch, release: values.release });
async function packageApp() {
  const work = join(root, '.build');
  await mkdir(work, { recursive: true });
  const staging = await mkdtemp(join(work, 'package-'));
  try {
    const source = join(staging, 'app');
    const books = join(staging, 'sample');
    await Promise.all([
      stageDesktop({ packaged: true, destination: source }),
      cp(sample, books, { recursive: true, filter: (path) => basename(path) !== '.imageflow' }),
    ]);
    const [output] = await packager({
      dir: source,
      out: join(root, 'out'),
      platform: 'darwin',
      arch: options.arch,
      electronVersion: metadata.devDependencies.electron,
      download: { cacheRoot: join(root, '.build', 'electron-cache'), checksums: electronChecksums },
      appBundleId: 'ch.wirhabenzeit.imageflow',
      appCategoryType: 'public.app-category.photography',
      extendInfo: {
        CFBundleIconFile: 'ImageFlow.icns',
        UTExportedTypeDeclarations: [{
          UTTypeIdentifier: 'ch.wirhabenzeit.imageflow.book',
          UTTypeDescription: 'ImageFlow Book',
          UTTypeConformsTo: ['com.apple.package'],
          UTTypeTagSpecification: { 'public.filename-extension': ['imageflow'] },
        }, {
          UTTypeIdentifier: 'ch.wirhabenzeit.imageflow.template',
          UTTypeDescription: 'ImageFlow Template',
          UTTypeConformsTo: ['public.zip-archive', 'public.data'],
          UTTypeTagSpecification: { 'public.filename-extension': ['imageflow-template'] },
        }],
        CFBundleDocumentTypes: [{
          CFBundleTypeName: 'ImageFlow Book', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Owner',
          LSItemContentTypes: ['ch.wirhabenzeit.imageflow.book'], LSTypeIsPackage: true,
          CFBundleTypeIconFile: 'ImageFlow.icns',
        }, {
          // Opening a template file imports it into the template library.
          CFBundleTypeName: 'ImageFlow Template', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Owner',
          LSItemContentTypes: ['ch.wirhabenzeit.imageflow.template'], CFBundleTypeIconFile: 'ImageFlow.icns',
        }],
      },
      // Agents run the MCP bridge with ImageFlow's executable in Node mode; keep it a plain file outside app.asar.
      asar: { unpackDir: 'node_modules/@img', unpack: '**/mcp-bridge.cjs' },
      extraResource: [esbuildBinary, books],
      icon: join(root, 'resources', 'ImageFlow.icns'),
      prune: false,
      overwrite: true,
      osxSign: {
        identity: options.identity || '-',
        identityValidation: !!options.identity,
        ...(options.keychain ? { keychain: options.keychain } : {}),
        continueOnError: false,
        batchCodesignCalls: true,
        preAutoEntitlements: false,
        optionsForFile: () => ({
          hardenedRuntime: !!options.identity,
          ...(options.identity ? { entitlements: join(root, 'resources/entitlements.mac.plist') } : {}),
        }),
      },
    });
    const app = join(output, 'ImageFlow.app');
    console.log('Mac app: ' + app);
    return app;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (options.notarization) {
  await notarizeMacRelease({ root, version: metadata.version, ...options }, packageApp);
} else {
  const app = await packageApp();
  if (options.identity) await verifyMacSigning(app, options.identity);
}

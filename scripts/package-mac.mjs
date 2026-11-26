import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };
import metadata from '../package.json' with { type: 'json' };
import { esbuildBinary, lightroomPlugin, sample, stageDesktop } from './stage-desktop.mjs';
import { renderTemplatePreviews } from './render-template-previews.mjs';
import { macBuildOptions } from './mac-build-options.mjs';
import { verifyMacSigning } from './verify-mac-signing.mjs';
import { notarizeMacRelease } from './mac-release-artifacts.mjs';
import { macSigningOptions } from './mac-signing-options.mjs';

if (process.platform !== 'darwin') throw new Error('Run the macOS build on a Mac.');

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { release: { type: 'boolean', default: false }, arch: { type: 'string' }, 'upgrade-fixture': { type: 'string' } } });
const fixture = values['upgrade-fixture'] ? JSON.parse(await readFile(values['upgrade-fixture'], 'utf8')) : null;
if (fixture && values.release) throw new Error('Upgrade fixtures cannot be release builds.');
if (fixture && (!resolve(fixture.output).startsWith(join(root, '.build/upgrade-test/')) || !resolve(fixture.profile).startsWith(join(root, '.build/upgrade-test/')) ||
    !/^https:\/\/127\.0\.0\.1:\d+\/updates$/.test(fixture.baseURL) || !/^9\.9\.(?:9(?:-beta\.[12])?|10)$/.test(fixture.version) || !resolve(fixture.book).startsWith(join(root, '.build/upgrade-test/')) || !Number.isInteger(fixture.debugPort) || fixture.debugPort < 1024 || fixture.debugPort > 65535)) throw new Error('Invalid isolated upgrade fixture.');
const options = macBuildOptions({ arch: values.arch, release: values.release });
async function packageApp() {
  // The app ships each starter's template and the project.json its example spreads come from, but no sample photos,
  // texts or files: new books never receive them, and the library's preview renders are made here at build time.
  const shippedSample = (path) => {
    const parts = relative(sample, path).split(sep).filter(Boolean);
    if (parts.includes('.imageflow')) return false;
    if (parts.length <= 1) return parts.length === 0 || !parts[0].includes('.') || parts[0].endsWith('.json');
    return parts[1] === 'template' || (parts.length === 2 && parts[1] === 'project.json');
  };
  const work = join(root, '.build');
  await mkdir(work, { recursive: true });
  const staging = await mkdtemp(join(work, 'package-'));
  try {
    const source = join(staging, 'app');
    const books = join(staging, 'sample');
    await Promise.all([
      stageDesktop({ packaged: true, destination: source, version: fixture?.version ?? metadata.version,
        updateTest: fixture ? { baseURL: fixture.baseURL, profile: fixture.profile, book: fixture.book, debugPort: fixture.debugPort } : null }),
      cp(sample, books, { recursive: true, filter: shippedSample }),
    ]);
    // New Book shows the built-in templates at once on first launch: their opening spreads ship pre-rendered.
    const previews = join(staging, 'template-previews');
    // Rendered from the full sample books in the repository, photos included; the app ships only the result.
    await renderTemplatePreviews({ app: source, books: sample, output: previews });
    const [output] = await packager({
      dir: source,
      out: fixture?.output ?? join(root, 'out'),
      appVersion: fixture?.version ?? metadata.version,
      platform: 'darwin',
      arch: options.arch,
      electronVersion: metadata.devDependencies.electron,
      download: { cacheRoot: join(root, '.build', 'electron-cache'), checksums: electronChecksums },
      appBundleId: fixture ? 'ch.wirhabenzeit.imageflow.upgrade-test' : 'ch.wirhabenzeit.imageflow',
      appCategoryType: 'public.app-category.photography',
      extendInfo: fixture ? {} : {
        // macOS 26 and later show the layered Icon Composer icon from Assets.car; earlier versions use ImageFlow.icns.
        CFBundleIconFile: 'ImageFlow.icns', CFBundleIconName: 'ImageFlow',
        // Shown when ImageFlow first asks to read the Photos library (Apple Photos provider, ADR 0013).
        NSPhotoLibraryUsageDescription: 'ImageFlow links photos you drag in from Photos and reads them to show and print your books. It never changes your library.',
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
          CFBundleTypeIconFile: 'ImageFlowBook.icns',
        }, {
          // Opening a template file imports it into the template library.
          CFBundleTypeName: 'ImageFlow Template', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Owner',
          LSItemContentTypes: ['ch.wirhabenzeit.imageflow.template'], CFBundleTypeIconFile: 'ImageFlowTemplate.icns',
        }],
      },
      // Agents run the MCP bridge with ImageFlow's executable in Node mode; keep it a plain file outside app.asar. The
      // skills it serves stay outside too: a bridge that outlives an update would read the new archive with its old index.
      asar: { unpackDir: '{node_modules/@img,skills}', unpack: '**/{mcp-bridge.cjs,mac-header.node,cloudkit.node,photos.node}' },
      // Document icons and the compiled Icon Composer app icon; the classic app icon comes from `icon` below.
      // Sources and generator: resources/brand/, npm run build:icons.
      // The Lightroom Classic plugin goes to Contents/Resources/ImageFlow.lrplugin, which Settings installs from (ADR 0011).
      extraResource: [esbuildBinary, books, previews, lightroomPlugin, ...['ImageFlowBook.icns', 'ImageFlowTemplate.icns', 'Assets.car'].map((icon) => join(root, 'resources', icon))],
      icon: join(root, 'resources', 'ImageFlow.icns'),
      prune: false,
      overwrite: true,
      // A fixture has another bundle ID, which the profile does not cover.
      osxSign: macSigningOptions(root, fixture ? { ...options, provisioningProfile: undefined } : options),
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
  if (options.identity) await verifyMacSigning(app, options.identity, { icloud: !fixture && !!options.provisioningProfile });
}

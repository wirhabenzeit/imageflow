import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { notarize } from '@electron/notarize';
import { macArtifactPaths } from './mac-paths.mjs';
import { run, verifyMacSigning, verifyMacVersion, verifyNotarization } from './verify-mac-signing.mjs';

export async function prepareMacRelease({ root, version, arch, notarization }) {
  const paths = macArtifactPaths(root, version, arch);
  // Clear stale release names before a rebuild or notarization attempt can fail.
  await Promise.all(Object.values(paths).map((path) => rm(path, { force: true })));
  await access(notarization.appleApiKey, constants.R_OK);
  await Promise.all([mkdir(join(root, 'out'), { recursive: true }), mkdir(join(root, '.build'), { recursive: true })]);
  return { ...paths, work: await mkdtemp(join(root, '.build/dmg-')) };
}

export async function notarizeMacRelease(options, build) {
  const { identity, version, notarization } = options;
  const prepared = await prepareMacRelease(options);
  try {
    const app = build ? await build() : options.app;
    await verifyMacVersion(app, version);
    await verifyMacSigning(app, identity);
    console.log('Submitting the signed app for notarization…');
    await notarize({ appPath: app, ...notarization });
    await verifyNotarization(app, true);
    return await macReleaseArtifacts({ ...options, app }, prepared);
  } finally {
    await rm(prepared.work, { recursive: true, force: true });
  }
}

async function macReleaseArtifacts({ app, identity, keychain, notarization }, { zip, dmg, work }) {
  const contents = join(work, 'contents');
  await mkdir(contents);
  // ditto preserves the bundle's signed resources and stapled ticket.
  await run('ditto', [app, join(contents, 'ImageFlow.app')]);
  await symlink('/Applications', join(contents, 'Applications'));
  const image = join(work, 'ImageFlow.dmg');
  await run('hdiutil', ['create', '-volname', 'ImageFlow', '-srcfolder', contents, '-format', 'UDZO', image]);
  await run('codesign', ['--force', '--sign', identity, '--timestamp', ...(keychain ? ['--keychain', keychain] : []), image]);
  await run('codesign', ['--verify', '--strict', image]);
  console.log('Submitting the signed DMG for notarization…');
  await notarize({ appPath: image, ...notarization });
  await verifyNotarization(image);
  const archive = join(work, 'ImageFlow.zip');
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  await rename(archive, zip);
  await rename(image, dmg);
  console.log('Release ZIP: ' + zip + '\nRelease DMG: ' + dmg);
  return { zip, dmg };
}

import { access, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { notarize } from '@electron/notarize';
import { run, verifyMacSigning, verifyNotarization } from './verify-mac-signing.mjs';

export function macArtifactPaths(root, version, arch) {
  return {
    zip: join(root, 'out', `ImageFlow-${version}-mac-${arch}.zip`),
    dmg: join(root, 'out', `ImageFlow-${version}-${arch}.dmg`),
  };
}

export async function notarizeMacRelease(options) {
  const { root, app, version, arch, identity, notarization } = options;
  await Promise.all(Object.values(macArtifactPaths(root, version, arch)).map((path) => rm(path, { force: true })));
  await access(notarization.appleApiKey);
  await verifyMacSigning(app, identity);
  console.log('Submitting the signed app for notarization…');
  await notarize({ appPath: app, ...notarization });
  await verifyNotarization(app, true);
  return macReleaseArtifacts(options);
}

export async function macReleaseArtifacts({ root, app, version, arch, identity, keychain, notarization }) {
  const out = join(root, 'out');
  await mkdir(out, { recursive: true });
  const { zip, dmg } = macArtifactPaths(root, version, arch);
  await Promise.all([rm(zip, { force: true }), rm(dmg, { force: true })]);
  const work = await mkdtemp(join(root, '.build/dmg-'));
  try {
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

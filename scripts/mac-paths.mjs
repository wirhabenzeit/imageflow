import { join } from 'node:path';

export const packagedMacApp = (root, arch = process.arch) => join(root, 'out', `ImageFlow-darwin-${arch}`, 'ImageFlow.app');
export const packagedMacExecutable = (root, arch = process.arch) => join(packagedMacApp(root, arch), 'Contents/MacOS/ImageFlow');
export const macArtifactPaths = (root, version, arch) => ({
  zip: join(root, 'out', `ImageFlow-${version}-mac-${arch}.zip`),
  dmg: join(root, 'out', `ImageFlow-${version}-${arch}.dmg`),
});

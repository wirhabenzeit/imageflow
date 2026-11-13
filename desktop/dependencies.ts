// npm dependencies of templates (ADR 0006). Books never read `template/node_modules`: an explicit rebuild bundles
// the packages a template imports into `template/vendor/`, which the template hash covers, and every load resolves
// bare imports through `vendor/manifest.json` alone.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Loader } from 'esbuild';
import { z } from 'zod';
import type { TemplatePackage } from '../src/library';

export const vendorFolder = 'vendor';
// Modules the host provides; templates and their dependencies share the app's copies.
export const hostModuleNames = new Set(['imageflow', 'react', 'react/jsx-runtime']);
const manifestSchema = z.object({
  version: z.literal(1),
  // SHA-256 of template/package-lock.json when the bundle was built, or '' without one.
  lockfile: z.string(),
  packages: z.record(z.string(), z.string()),
  modules: z.record(z.string(), z.object({ js: z.string().optional(), css: z.string().optional(), exports: z.array(z.string()) })),
  // Packages without declarations: the type check sees them as `any` and warns.
  untyped: z.array(z.string()),
  licenses: z.record(z.string(), z.string()),
  // Each package's declared licence (its package.json `license`), shown before a template is imported.
  licenseNames: z.record(z.string(), z.string()).optional(),
});
export type DependencyManifest = z.infer<typeof manifestSchema>;

const slash = (path: string) => path.split(sep).join('/');
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
export const isBareImport = (path: string) => !path.startsWith('./') && !path.startsWith('../') && !path.startsWith('/') && !/^[a-z]+:/i.test(path);
// `@scope/name/sub` → `@scope/name`; `name/sub` → `name`.
export const packageName = (specifier: string) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

export async function readDependencyManifest(root: string): Promise<DependencyManifest | undefined> {
  const source = await readFile(join(root, vendorFolder, 'manifest.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (source === undefined) return undefined;
  const parsed = manifestSchema.safeParse(JSON.parse(source));
  if (!parsed.success) throw new Error('template/vendor/manifest.json is invalid. Rebuild the template dependencies.');
  return parsed.data;
}

/** The packages in a template's saved bundle, with versions and licences, as the library shows them before import. */
export async function templatePackages(root: string): Promise<TemplatePackage[]> {
  const manifest = await readDependencyManifest(root).catch(() => undefined);
  if (!manifest) return [];
  return Object.entries(manifest.packages).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => {
    const declared = manifest.licenseNames?.[name] ?? manifest.licenses[name] ?? '';
    return { name, version, license: declared.startsWith('LICENSES/') ? '' : declared };
  });
}

async function lockfileHash(root: string) {
  const lock = await readFile(join(root, 'package-lock.json')).catch(() => undefined);
  return lock ? createHash('sha256').update(lock).digest('hex') : '';
}

/** A warning when installed packages no longer match the saved bundle; books keep using the saved bundle. */
export async function dependencyWarning(root: string, manifest: DependencyManifest | undefined) {
  const hasPackage = await stat(join(root, 'package.json')).then(() => true, () => false);
  if (!hasPackage) return undefined;
  if (!manifest) {
    return 'The template has a package.json but no saved dependency bundle. Run the template dependency rebuild script after npm install.';
  }
  const lock = await lockfileHash(root);
  if (lock && lock !== manifest.lockfile) {
    return 'template/package-lock.json changed since the dependency bundle was saved; the book still uses the saved bundle. ' +
      'Run the template dependency rebuild script to use the installed packages.';
  }
  return manifest.untyped.length ? 'These template dependencies have no type declarations, so the type check treats them as any: ' +
    manifest.untyped.join(', ') + '. Install their @types packages and rebuild the dependencies.' : undefined;
}

/** The module a bare import resolves to: its saved JS and CSS, as source for the bundler's virtual module. */
export function vendoredModule(_root: string, manifest: DependencyManifest | undefined, specifier: string) {
  const entry = manifest?.modules[specifier];
  if (!entry) return undefined;
  const lines: string[] = [];
  const at = (path: string) => JSON.stringify('./' + vendorFolder + '/' + path);
  if (entry.css) lines.push('import ' + at(entry.css) + ';');
  if (entry.js) {
    lines.push('export * from ' + at(entry.js) + ';');
    if (entry.exports.includes('default')) lines.push('export { default } from ' + at(entry.js) + ';');
  }
  return lines.join('\n') + '\n';
}

export const missingDependency = (specifier: string) => 'The template imports ' + specifier + ', which is not in its saved dependency bundle ' +
  '(template/vendor/manifest.json). Install it in template/ with npm install, then run the template dependency rebuild script.';

const assetLoaders: Record<string, Loader> = Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.otf']
  .map((extension) => [extension, 'dataurl' as const]));

/** The bare imports of a template's own source, through its relative imports. */
export async function templateImports(root: string) {
  const { build } = await import('esbuild');
  const found = new Set<string>();
  await build({
    entryPoints: [join(root, 'index.tsx')], bundle: true, write: false, format: 'esm', jsx: 'automatic', logLevel: 'silent',
    absWorkingDir: root, tsconfigRaw: {}, loader: { ...assetLoaders, '.css': 'empty' },
    plugins: [{ name: 'collect-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point' || !isBareImport(args.path)) return undefined;
        if (!hostModuleNames.has(args.path)) found.add(args.path);
        return { path: args.path, external: true };
      });
    } }],
  });
  return [...found].sort();
}

async function licenseFiles(directory: string) {
  const entries = await readdir(directory).catch(() => [] as string[]);
  return entries.filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
}

/**
 * Copies the declaration files the given packages' types reach into `vendor/types/packages/`, laid out by package
 * name. The folder is not called node_modules, which .gitignore files and template export leave out.
 */
async function vendorTypes(root: string, packages: string[], target: string) {
  const ts = (await import('typescript')).default;
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    types: [], noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const containing = join(root, 'index.ts');
  const untyped: string[] = [];
  const entries: string[] = [];
  for (const name of packages) {
    let resolved = ts.resolveModuleName(name, containing, options, host).resolvedModule;
    if (!resolved?.extension.startsWith('.d.')) resolved = ts.resolveModuleName('@types/' + name.replace(/^@([^/]+)\//, '$1__'), containing, options, host).resolvedModule;
    if (resolved?.extension.startsWith('.d.')) entries.push(resolved.resolvedFileName);
    else untyped.push(name);
  }
  const modules = join(root, 'node_modules');
  const copied = new Set<string>();
  // Ambient @types packages the copied packages depend on (such as @types/geojson): they declare globals, so
  // nothing imports them; globals.d.ts references them for the type check and code editors.
  const ambient = new Set<string>();
  for (let round = 0; entries.length && round < 8; round++) {
    const roots = [...entries, ...[...ambient].map((name) => ts.resolveModuleName(name, containing, options, host).resolvedModule?.resolvedFileName)
      .filter((path): path is string => !!path)];
    const program = ts.createProgram(roots, options, host);
    for (const file of program.getSourceFiles()) {
      if (!inside(modules, file.fileName)) continue;
      const path = relative(modules, file.fileName);
      await mkdir(dirname(join(target, path)), { recursive: true });
      await cp(file.fileName, join(target, path));
      // Each package's package.json, so `types` and `exports` resolve the same way from the copy.
      const owner = path.split(sep).slice(0, path.startsWith('@') ? 2 : 1).join(sep);
      if (!copied.has(owner)) {
        copied.add(owner);
        await cp(join(modules, owner, 'package.json'), join(target, owner, 'package.json')).catch(() => {});
      }
    }
    const before = ambient.size;
    for (const owner of copied) {
      const info = JSON.parse(await readFile(join(modules, owner, 'package.json'), 'utf8').catch(() => '{}'));
      for (const name of Object.keys({ ...info.dependencies, ...info.peerDependencies })) {
        if (name.startsWith('@types/') && await stat(join(modules, name)).then(() => true, () => false)) ambient.add(name);
      }
    }
    if (ambient.size === before) break;
  }
  if (ambient.size) {
    await writeFile(join(target, '..', 'globals.d.ts'), [...ambient].sort().map((name) => {
      const entry = ts.resolveModuleName(name, containing, options, host).resolvedModule?.resolvedFileName;
      return entry ? '/// <reference path="./packages/' + slash(relative(modules, entry)) + '" />' : '';
    }).filter(Boolean).join('\n') + '\n');
  }
  return untyped;
}

/**
 * Bundles the packages the template imports from `template/node_modules` into `template/vendor/`, replacing it
 * atomically. Without bare imports, `vendor/` is removed. Returns the new manifest.
 */
export async function rebuildDependencies(root: string): Promise<DependencyManifest | undefined> {
  const specifiers = await templateImports(root);
  const vendor = join(root, vendorFolder);
  const staging = join(root, '.vendor-' + process.pid + '-' + Date.now());
  const replace = async () => {
    const previous = vendor + '.previous-' + Date.now();
    const had = await stat(vendor).then(() => true, () => false);
    if (had) await rename(vendor, previous);
    try { await rename(staging, vendor); } catch (error) { if (had) await rename(previous, vendor); throw error; }
    if (had) await rm(previous, { recursive: true, force: true });
  };
  if (!specifiers.length) {
    await rm(vendor, { recursive: true, force: true });
    return undefined;
  }
  const modules = join(root, 'node_modules');
  if (!await stat(modules).then((info) => info.isDirectory(), () => false)) {
    throw new Error('The template imports ' + specifiers.join(', ') + ' but template/node_modules is missing. Run npm install in template/ first.');
  }
  const own = (name: string) => ['react', 'react-dom', 'imageflow'].includes(name);
  const conflicting = specifiers.filter((specifier) => own(packageName(specifier)));
  if (conflicting.length) throw new Error('ImageFlow provides React and imageflow; import them directly, not ' + conflicting.join(', ') + '.');
  const { build } = await import('esbuild');
  try {
    await mkdir(staging, { recursive: true });
    const outdir = join(staging, 'modules');
    const result = await build({
      entryPoints: specifiers.map((specifier, i) => ({ in: specifier, out: 'm' + i })),
      absWorkingDir: root, outdir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
      minify: true, legalComments: 'none', metafile: true, write: true, logLevel: 'silent', chunkNames: 'chunk-[hash]',
      external: [...hostModuleNames], loader: assetLoaders, define: { 'process.env.NODE_ENV': '"production"' },
      nodePaths: [modules],
    });
    const outputs = Object.entries(result.metafile.outputs);
    const manifest: DependencyManifest = { version: 1, lockfile: await lockfileHash(root), packages: {}, modules: {}, untyped: [], licenses: {}, licenseNames: {} };
    specifiers.forEach((specifier, i) => {
      const js = outputs.find(([path]) => basename(path) === 'm' + i + '.js');
      const css = outputs.find(([path]) => basename(path) === 'm' + i + '.css');
      manifest.modules[specifier] = {
        ...(js ? { js: slash(relative(staging, resolve(root, js[0]))) } : {}),
        ...(css ? { css: slash(relative(staging, resolve(root, css[0]))) } : {}),
        exports: js ? [...js[1].exports].sort() : [],
      };
    });
    // Every package that contributed code, with its version and licence.
    const directories = new Set<string>();
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = resolve(root, input);
      if (!inside(modules, path)) continue;
      const parts = relative(modules, path).split(sep);
      // Nested node_modules belong to the innermost package.
      const index = parts.lastIndexOf('node_modules') + 1;
      const name = parts.slice(index, index + (parts[index]?.startsWith('@') ? 2 : 1));
      directories.add(join(modules, ...parts.slice(0, index), ...name));
    }
    await mkdir(join(staging, 'LICENSES'), { recursive: true });
    for (const directory of [...directories].sort()) {
      const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'));
      const name = typeof info.name === 'string' ? info.name : relative(modules, directory);
      manifest.packages[name] = typeof info.version === 'string' ? info.version : '';
      const files = await licenseFiles(directory);
      if (files.length) {
        const target = name.replace(/\//g, '__') + '.txt';
        const texts = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')));
        await writeFile(join(staging, 'LICENSES', target), texts.join('\n\n'));
        manifest.licenses[name] = 'LICENSES/' + target;
      } else manifest.licenses[name] = typeof info.license === 'string' ? info.license : '';
      manifest.licenseNames![name] = typeof info.license === 'string' ? info.license : '';
    }
    manifest.untyped = await vendorTypes(root, [...new Set(specifiers.filter((specifier) => extname(specifier) !== '.css').map(packageName))],
      join(staging, 'types', 'packages'));
    if (manifest.untyped.length) {
      await mkdir(join(staging, 'types'), { recursive: true });
      await writeFile(join(staging, 'types', 'untyped.d.ts'), manifest.untyped.map((name) => 'declare module ' + JSON.stringify(name) + ';').join('\n') + '\n');
    }
    // Packages ship declarations in folders such as dist/ that ignore rules commonly drop; the saved bundle must be kept whole.
    await writeFile(join(staging, '.gitignore'), '# The saved dependency bundle of this template (ImageFlow ADR 0006). Keep every file.\n!*\n');
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await replace();
    await updateTsconfig(root);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Points code editors at the vendored declarations, as the book's type check does, when tsconfig.json is plain JSON. */
async function updateTsconfig(root: string) {
  const path = join(root, 'tsconfig.json');
  let config: { compilerOptions?: { paths?: Record<string, string[]> }; exclude?: string[]; files?: string[] };
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
  config.compilerOptions ??= {};
  config.compilerOptions.paths = { ...config.compilerOptions.paths,
    '*': ['./vendor/types/packages/*', './vendor/types/packages/@types/*'] };
  config.exclude = [...new Set([...(config.exclude ?? []), 'node_modules', 'vendor'])];
  const globals = await stat(join(root, vendorFolder, 'types', 'globals.d.ts')).then(() => true, () => false);
  const files = (config as { files?: string[] }).files?.filter((name) => name !== 'vendor/types/globals.d.ts') ?? [];
  if (globals) (config as { files?: string[] }).files = [...files, 'vendor/types/globals.d.ts'];
  else if ((config as { files?: string[] }).files) (config as { files?: string[] }).files = files;
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
}

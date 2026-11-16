// Installs a template's npm packages outside its book (ADR 0006): into an app-managed cache keyed by the template's
// package.json and lockfile, so a book never carries node_modules. The rebuild then bundles from there into
// template/vendor/, which is all a book reads. npm is the one on this Mac; the app does not ship it.
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

export class DependencyInstallError extends Error {
  constructor(readonly code: 'npm-unavailable' | 'npm-failed' | 'package-invalid', message: string) { super(message); }
}

export type Npm = { command: string; path: string };
const complete = '.imageflow-installed';
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

async function executable(path: string) { return access(path, constants.X_OK).then(() => true, () => false); }

// Apps opened from Finder get a minimal PATH; the user's shell knows where npm lives (Homebrew, nvm, Volta, fnm…).
function shellPath(env: NodeJS.ProcessEnv) {
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  return new Promise<string>((done) => {
    execFile(shell, ['-ilc', 'printf "\\n__IMAGEFLOW_PATH__%s__IMAGEFLOW_PATH__" "$PATH"'], { timeout: 8000, env }, (_error, stdout) => {
      done(/__IMAGEFLOW_PATH__(.*)__IMAGEFLOW_PATH__/.exec(String(stdout ?? ''))?.[1] ?? '');
    });
  });
}

let found: Promise<Npm | undefined> | undefined;
/** The npm on this Mac, and a PATH under which it finds its node. Looked up once per run. */
export function findNpm(env: NodeJS.ProcessEnv = process.env): Promise<Npm | undefined> {
  found ??= (async () => {
    const home = homedir();
    const common = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.volta', 'bin'), join(home, '.local', 'bin'), '/usr/bin'];
    const search = async (path: string) => {
      for (const directory of path.split(delimiter).filter(Boolean)) {
        if (await executable(join(directory, 'npm'))) return { command: join(directory, 'npm'), path };
      }
      return undefined;
    };
    return await search(env.PATH ?? '') ?? await search(await shellPath(env)) ?? await search(common.join(delimiter));
  })().then((npm) => { if (!npm) found = undefined; return npm; });
  return found;
}

/** The template's package.json as installed from elsewhere: `file:` dependencies point at the same folders, absolutely. */
async function relocatedPackage(template: string) {
  let info: Record<string, unknown>;
  try { info = JSON.parse(await readFile(join(template, 'package.json'), 'utf8')); }
  catch (error) { throw new DependencyInstallError('package-invalid', 'template/package.json could not be read: ' + (error as Error).message); }
  // npm names the lockfile after the folder when package.json has no name, so the install folder takes the name the
  // template's lockfile already has, or the template folder's: the lockfile npm writes then matches the template's.
  const locked = await readFile(join(template, 'package-lock.json'), 'utf8').then((text) => JSON.parse(text).name, () => undefined);
  const folder = typeof info.name === 'string' ? 'package' : typeof locked === 'string' && /^[\w.-]{1,100}$/.test(locked) && !locked.startsWith('.') ? locked : basename(template);
  let linked = false;
  for (const field of dependencyFields) {
    const entries = info[field];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
      (entries as Record<string, string>)[name] = 'file:' + resolve(template, spec.slice('file:'.length));
      linked = true;
    }
  }
  return { info, linked, folder };
}

const digest = (...parts: (string | Buffer)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex').slice(0, 32);
};

function runNpm(npm: Npm, cwd: string, args: string[]) {
  return new Promise<void>((done, fail) => {
    const child = spawn(npm.command, args, { cwd, env: { ...process.env, PATH: npm.path, npm_config_update_notifier: 'false',
      npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.once('error', (error) => { clearTimeout(timer); fail(new DependencyInstallError('npm-failed', 'npm could not start: ' + error.message)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return done();
      const detail = errors.split('\n').filter((line) => /\berr(or)?!?\b/i.test(line)).slice(-6).join('\n') || errors.trim().split('\n').slice(-6).join('\n');
      fail(new DependencyInstallError('npm-failed', 'npm install failed (' + (signal ?? 'exit ' + code) + ')' + (detail ? ':\n' + detail : '.')));
    });
  });
}

export type InstalledDependencies = {
  /** The node_modules folder to bundle from. */
  modules: string;
  /** True when an earlier install of the same package.json and lockfile was reused. */
  reused: boolean;
  /** The lockfile npm wrote, when it differs from the template's and belongs back in it. */
  lockfile?: Buffer;
};

// One install per key at a time, outliving the request that started it: an agent's call may time out while npm runs,
// and calling again picks up the same install.
const running = new Map<string, Promise<InstalledDependencies>>();

/**
 * Installs the template's packages into `cache/<key>/node_modules`, where the key is the hash of its package.json (with
 * `file:` paths made absolute) and package-lock.json. An existing install with that key is reused. Install scripts do
 * not run: a template's packages are bundled for the browser, never executed here. Keeps the `keep` most recently used
 * installs and removes older ones.
 */
export async function installTemplateDependencies(template: string, cache: string, options: { npm?: Npm; keep?: number } = {}) {
  const { info, linked, folder } = await relocatedPackage(template);
  const lock = await readFile(join(template, 'package-lock.json')).catch(() => undefined);
  const packageText = JSON.stringify(info, null, 2) + '\n';
  const key = digest(packageText, lock ?? '', folder);
  const directory = join(cache, key);
  if (await stat(join(directory, folder, 'node_modules', complete)).then(() => true, () => false)) {
    const now = new Date();
    await utimes(directory, now, now).catch(() => {});
    return { modules: join(directory, folder, 'node_modules'), reused: true } satisfies InstalledDependencies;
  }
  const pending = running.get(key);
  if (pending) return pending;
  const task = (async (): Promise<InstalledDependencies> => {
    const npm = options.npm ?? await findNpm();
    if (!npm) {
      throw new DependencyInstallError('npm-unavailable', 'ImageFlow uses npm to install template packages, and none was found on this Mac. ' +
        'Install Node.js (which includes npm), for example from nodejs.org or with Homebrew, then try again.');
    }
    await mkdir(cache, { recursive: true });
    const staging = join(cache, key + '.' + randomUUID().slice(0, 8) + '.tmp');
    const work = join(staging, folder);
    await mkdir(work, { recursive: true });
    try {
      await writeFile(join(work, 'package.json'), packageText);
      // A lockfile records linked folders relative to the template, which do not hold from the cache.
      if (lock && !linked) await writeFile(join(work, 'package-lock.json'), lock);
      await runNpm(npm, work, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
      await mkdir(join(work, 'node_modules'), { recursive: true });
      await writeFile(join(work, 'node_modules', complete), new Date().toISOString() + '\n');
      const written = await readFile(join(work, 'package-lock.json')).catch(() => undefined);
      const lockfile = !linked && written && (!lock || !written.equals(lock)) ? written : undefined;
      // Stored under the key the template will have once its lockfile is updated, so the next rebuild reuses it.
      const finalKey = lockfile ? digest(packageText, lockfile, folder) : key;
      const target = join(cache, finalKey);
      try { await rename(staging, target); }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      await prune(cache, options.keep ?? 4, finalKey);
      return { modules: join(target, folder, 'node_modules'), reused: false, ...(lockfile ? { lockfile } : {}) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  })();
  running.set(key, task);
  try { return await task; } finally { running.delete(key); }
}

/** Removes all but the `keep` most recently used installs, and staging folders left behind for over a day. */
async function prune(cache: string, keep: number, current: string) {
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const installs: { name: string; used: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await stat(join(cache, entry.name)).catch(() => undefined);
    if (!info) continue;
    if (entry.name.endsWith('.tmp')) { if (Date.now() - info.mtimeMs > 86_400_000) await rm(join(cache, entry.name), { recursive: true, force: true }); continue; }
    if (entry.name !== current) installs.push({ name: entry.name, used: info.mtimeMs });
  }
  installs.sort((a, b) => b.used - a.used);
  for (const { name } of installs.slice(Math.max(0, keep - 1))) await rm(join(cache, name), { recursive: true, force: true });
}

export type DependencyRebuild = {
  /** Package names and versions in the new saved bundle, from node_modules; linked `file:` folders are not listed. */
  packages: Record<string, string>;
  /** The bare imports the bundle provides; empty when the template imports no packages. */
  imports: string[];
  /** Imports without type declarations. */
  untyped: string[];
  reused: boolean;
  lockfileUpdated: boolean;
  /** template/node_modules still exists; the book does not use it. */
  leftoverNodeModules: boolean;
};

/**
 * Installs the template's packages outside the book, writes npm's updated lockfile back, and bundles them into
 * template/vendor/. Without a package.json, nothing is installed and the bundle covers no packages.
 */
export async function rebuildTemplateDependencies(template: string, cache: string, options: { npm?: Npm; keep?: number } = {}): Promise<DependencyRebuild> {
  const { rebuildDependencies, templateImports } = await import('./dependencies');
  const hasPackage = await stat(join(template, 'package.json')).then((info) => info.isFile(), () => false);
  const imports = await templateImports(template);
  if (imports.length && !hasPackage) {
    throw new DependencyInstallError('package-invalid', 'The template imports ' + imports.join(', ') + ' but has no package.json. ' +
      'Add template/package.json with these packages under "dependencies", then rebuild.');
  }
  const install = hasPackage && imports.length ? await installTemplateDependencies(template, cache, options) : undefined;
  if (install?.lockfile) await writeFile(join(template, 'package-lock.json'), install.lockfile);
  const manifest = await rebuildDependencies(template, install?.modules ?? join(cache, 'none', 'node_modules'));
  return { packages: manifest?.packages ?? {}, imports: Object.keys(manifest?.modules ?? {}).sort(), untyped: manifest?.untyped ?? [], reused: install?.reused ?? true,
    lockfileUpdated: !!install?.lockfile,
    leftoverNodeModules: await stat(join(template, 'node_modules')).then((info) => info.isDirectory(), () => false) };
}

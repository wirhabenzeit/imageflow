import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compare, valid } from 'semver';
import type { LightroomPluginStatus } from '../../src/desktop';
import { lightroomApplication } from './launch';

/**
 * Installing and updating the ImageFlow plugin for Lightroom Classic (ADR 0011, section 5). ImageFlow bundles the
 * plugin (Contents/Resources/ImageFlow.lrplugin) and copies it, on request from Settings, into Lightroom's Modules
 * folder, which Lightroom loads at start. Both folders are parameters, so tests use temporary ones and never touch
 * Lightroom's own.
 */
export const pluginFolder = 'ImageFlow.lrplugin';
/** Where Lightroom Classic loads plugins from without asking. */
export const defaultModules = () => join(homedir(), 'Library', 'Application Support', 'Adobe', 'Lightroom', 'Modules');
export type PluginLocations = { bundled: string; modules: string };

/** The version a plugin folder's Info.lua declares (`VERSION = { major, minor, revision }`), or undefined. */
export async function pluginVersion(folder: string): Promise<string | undefined> {
  const info = await readFile(join(folder, 'Info.lua'), 'utf8').catch(() => undefined);
  const table = info && /VERSION\s*=\s*\{([^}]*)\}/.exec(info)?.[1];
  if (!table) return undefined;
  const part = (name: string) => /^\d{1,6}$/.exec(new RegExp('\\b' + name + '\\s*=\\s*(\\d+)').exec(table)?.[1] ?? '')?.[0];
  const [major, minor, revision] = [part('major'), part('minor'), part('revision') ?? '0'];
  const version = major && minor ? major + '.' + minor + '.' + revision : undefined;
  return version && valid(version) ? version : undefined;
}

/** Whether the plugin is installed, in which version, and how that compares with the one ImageFlow bundles. */
export async function pluginStatus({ bundled, modules }: PluginLocations): Promise<LightroomPluginStatus> {
  const target = join(modules, pluginFolder);
  const available = await pluginVersion(bundled);
  const info = await lstat(target).catch(() => undefined);
  const installed = info ? await pluginVersion(target) : undefined;
  const state: LightroomPluginStatus['state'] = !info ? 'missing' : info.isSymbolicLink() ? 'linked' : !installed || !available ? 'unknown'
    : compare(installed, available) < 0 ? 'outdated' : compare(installed, available) > 0 ? 'newer' : 'current';
  return { state, ...(installed ? { installed } : {}), ...(available ? { available } : {}) };
}

/**
 * Copies the bundled plugin into the Modules folder, replacing an older copy only once the new one is complete, so a
 * failed copy leaves the installed plugin as it was. A link there is a development copy and is left alone.
 */
export async function installPlugin({ bundled, modules }: PluginLocations): Promise<LightroomPluginStatus> {
  if (!await pluginVersion(bundled)) throw new Error('This copy of ImageFlow has no Lightroom plugin to install.');
  const target = join(modules, pluginFolder);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error('ImageFlow.lrplugin in Lightroom’s Modules folder is a link to another copy. Remove the link to install this version.');
  if (existing && !existing.isDirectory()) throw new Error('Lightroom’s Modules folder holds a file named ImageFlow.lrplugin. Remove it to install the plugin.');
  await mkdir(modules, { recursive: true });
  // Names Lightroom does not load: they do not end in .lrplugin.
  const staging = join(modules, '.imageflow-install-' + randomUUID());
  const previous = join(modules, '.imageflow-previous-' + randomUUID());
  try {
    await cp(bundled, staging, { recursive: true, errorOnExist: true, force: false });
    if (existing) await rename(target, previous);
    try { await rename(staging, target); }
    catch (error) { if (existing) await rename(previous, target).catch(() => {}); throw error; }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
  return pluginStatus({ bundled, modules });
}

/** Whether Lightroom Classic is running now, so Settings can say that it must be restarted to load the plugin. */
export function lightroomRunning(): Promise<boolean> {
  return new Promise((resolve) => execFile('/usr/bin/pgrep', ['-x', lightroomApplication], { timeout: 5000 }, (error) => resolve(!error)));
}

/** What Settings says after an install: what was installed, and whether Lightroom must be restarted for it. */
export function installMessage(before: LightroomPluginStatus, after: LightroomPluginStatus, running: boolean) {
  const what = (before.installed ? 'Updated the ImageFlow plugin to ' : 'Installed the ImageFlow plugin ') + (after.installed ?? '') + '.';
  if (running) return what + ' Quit and reopen Lightroom Classic to load it.';
  return what + ' It loads the next time you open Lightroom Classic' + (before.installed ? '.' : '; if File → Plug-in Manager lists it as disabled, enable it there.');
}

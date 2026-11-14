import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultSettings } from '../src/settings';
import type { AppSettings } from '../src/settings';

function applyPatch(current: AppSettings, patch: unknown): AppSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some((key) => key !== 'appearance' && key !== 'newBookSize')) throw new Error('Invalid app settings.');
  const appearance = 'appearance' in patch ? patch.appearance : current.appearance;
  if (appearance !== 'light' && appearance !== 'dark' && appearance !== 'system') throw new Error('Invalid appearance setting.');
  const newBookSize = 'newBookSize' in patch ? patch.newBookSize as { width?: unknown; height?: unknown } : current.newBookSize;
  if (newBookSize && (!Number.isInteger(newBookSize.width) || !Number.isInteger(newBookSize.height) ||
      Number(newBookSize.width) < 560 || Number(newBookSize.width) > 4000 || Number(newBookSize.height) < 420 || Number(newBookSize.height) > 3000)) throw new Error('Invalid window size.');
  return { appearance, ...(newBookSize ? { newBookSize: newBookSize as {width:number;height:number} } : {}) };
}

export class SettingsStore {
  value = { ...defaultSettings };
  private writes = Promise.resolve();
  constructor(private file: string) {}

  async load() {
    try {
      const { importMode: _legacy, ...saved } = JSON.parse(await readFile(this.file, 'utf8'));
      this.value = applyPatch(defaultSettings, saved);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('ImageFlow could not read its settings; using defaults.', error);
    }
  }

  update(patch: unknown): Promise<AppSettings> {
    const write = this.writes.then(async () => {
      const next = applyPatch(this.value, patch);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(next, null, 2) + '\n');
      await rename(this.file + '.tmp', this.file);
      this.value = next;
      return next;
    });
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  settled() { return this.writes; }
}

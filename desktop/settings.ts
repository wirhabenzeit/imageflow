import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { isUpdateChannel } from '../src/update-feed';
import { defaultSettings } from '../src/settings';
import type { AppSettings, SyncBackend } from '../src/settings';

/** A sync backend as stored, checked per kind (ADR 0012). */
function syncBackend(value: unknown): SyncBackend {
  const backend = value as Partial<SyncBackend> | null;
  switch (backend && typeof backend === 'object' ? backend.kind : undefined) {
    case 'folder':
      if (Object.keys(backend!).length === 2 && typeof backend!.path === 'string' && isAbsolute(backend!.path) && backend!.path.length <= 4096) return { kind: 'folder', path: backend!.path };
      break;
  }
  throw new Error('Invalid sync setting.');
}

function applyPatch(current: AppSettings, patch: unknown): AppSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some((key) => key !== 'appearance' && key !== 'newBookSize' && key !== 'automaticUpdates' && key !== 'updateChannel' && key !== 'agentAccess' && key !== 'keepOriginals' && key !== 'sync')) throw new Error('Invalid app settings.');
  const appearance = 'appearance' in patch ? patch.appearance : current.appearance;
  if (appearance !== 'light' && appearance !== 'dark' && appearance !== 'system') throw new Error('Invalid appearance setting.');
  const newBookSize = 'newBookSize' in patch ? patch.newBookSize as { width?: unknown; height?: unknown } : current.newBookSize;
  if (newBookSize && (!Number.isInteger(newBookSize.width) || !Number.isInteger(newBookSize.height) ||
      Number(newBookSize.width) < 560 || Number(newBookSize.width) > 4000 || Number(newBookSize.height) < 420 || Number(newBookSize.height) > 3000)) throw new Error('Invalid window size.');
  const automaticUpdates = 'automaticUpdates' in patch ? patch.automaticUpdates : current.automaticUpdates;
  if (typeof automaticUpdates !== 'boolean') throw new Error('Invalid automatic update setting.');
  const updateChannel = 'updateChannel' in patch ? patch.updateChannel : current.updateChannel;
  if (!isUpdateChannel(updateChannel)) throw new Error('Invalid update channel.');
  const agentAccess = 'agentAccess' in patch ? patch.agentAccess : current.agentAccess;
  if (agentAccess !== undefined && typeof agentAccess !== 'boolean') throw new Error('Invalid agent access setting.');
  const keepOriginals = 'keepOriginals' in patch ? patch.keepOriginals : current.keepOriginals;
  if (keepOriginals !== undefined && typeof keepOriginals !== 'boolean') throw new Error('Invalid keep originals setting.');
  const sync = 'sync' in patch ? patch.sync : current.sync;
  return { appearance, automaticUpdates, updateChannel, ...(newBookSize ? { newBookSize: newBookSize as {width:number;height:number} } : {}),
    ...(agentAccess ? { agentAccess: true } : {}), ...(keepOriginals === false ? { keepOriginals: false } : {}), ...(sync !== undefined && sync !== null ? { sync: syncBackend(sync) } : {}) };
}

export class SettingsStore {
  value: AppSettings;
  private writes = Promise.resolve();
  constructor(private file: string, initial: AppSettings = defaultSettings) { this.value = { ...initial }; }

  async load() {
    try {
      // The former development-only app default does not override a book's own future-import policy. Faster book
      // updates (beta.12 to beta.15) was removed: rendering each edit in new frames measured as fast.
      const { importMode: _legacy, fasterBookUpdates: _removed, sync, ...saved } = JSON.parse(await readFile(this.file, 'utf8'));
      this.value = applyPatch(this.value, saved);
      // A sync backend this version cannot read (a kind a newer version added) leaves sync off here; it does not cost
      // the other settings their values.
      try { this.value = applyPatch(this.value, { sync }); }
      catch (error) { console.warn('ImageFlow could not read its sync setting; sync is off.', error); }
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

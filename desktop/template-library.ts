import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TemplateInfo } from '../src/desktop';
import type { LibraryEntry, LibraryImportResult, TemplatePackage } from '../src/library';
import { resolveFormat } from '../src/format';
import { templatePackages } from './dependencies';
import { hashTemplateFiles, listTemplateFiles, TemplateFilesError } from './template-hash.mjs';
import { extractTemplateArchive, isTemplateArchive, writeTemplateArchive } from './template-archive';
import { readTemplatePreview } from './template-preview-file';
import { trimAspect } from '../src/template-preview';

// The template library: templates a new book can be created from. A book copies its template when it is created,
// so nothing here is read while a book renders, and removing or replacing an entry never changes an existing book.
// User templates live in a hidden folder, one entry per template ID: `<root>/<id>/template/` holds the source exactly
// as imported and `<root>/<id>/library.json` the metadata derived from it.
//
// Each entry has up to two pictures for the New Book picker and the Templates window, both tied to the template's hash:
// the template's own preview image (`preview` in defineTemplate), checked when the template is read, and a saved render
// of its opening spread. An imported template's render is `<root>/<id>/preview-<hash>.jpg`, so it goes with the entry.
// Built-in templates ship their renders with the app (`renders.shipped/<hash>.jpg`); renders made later are kept in
// `renders.cache/<hash>.jpg`.

/** Thrown when a folder is not an importable template; `details` lists further findings. */
export class TemplateImportError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'TemplateImportError';
  }
}

/**
 * The files that make up a template folder (see listTemplateFiles): dotfiles, `.imageflow/` and `node_modules/` are
 * left out, and symbolic links are refused. A folder without `index.tsx` is not a template.
 */
export async function templateFiles(folder: string) {
  const files = await listTemplateFiles(folder).catch((error) => {
    throw error instanceof TemplateFilesError ? new TemplateImportError(error.message) : error;
  });
  if (!files.includes('index.tsx')) throw new TemplateImportError('This folder is not an ImageFlow template: it has no index.tsx.');
  return files;
}

/** A hash of a template's files and their paths, so the same template has the same hash wherever it is copied. */
export async function templateHash(folder: string, files?: string[]) {
  return hashTemplateFiles(folder, files ?? await templateFiles(folder));
}

/** Copies a template's files (see templateFiles) into `destination`, which must not exist yet. */
export async function copyTemplate(source: string, destination: string, files?: string[]) {
  const list = files ?? await templateFiles(source);
  await mkdir(destination, { recursive: true });
  for (const file of list) {
    const target = join(destination, ...file.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(source, ...file.split('/')), target, { errorOnExist: true, force: false });
  }
  return list;
}

/** Compares versions as dot-separated numbers (`1.10.0` after `1.9.2`); other parts compare as text. */
export function compareVersions(a: string, b: string) {
  const left = a.split(/[.+-]/);
  const right = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [x, y] = [left[i] ?? '0', right[i] ?? '0'];
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order) return Math.sign(order);
  }
  return 0;
}

// Written by the app; rebuilt from the source when missing or written for other app capabilities.
type Metadata = {
  schema: 1; capabilities: string; hash: string; importedAt: string; importedFrom?: string;
  info?: TemplateInfo; problem?: string;
  // The template's own preview image, when the file it declares can be shown; `imageProblem` says why not.
  image?: string; imageProblem?: string;
};
/** Where saved renders of opening spreads live; see the comment at the top. */
export type RenderFolders = { shipped?: string; cache: string };
type Found = { entry: LibraryEntry; folder: string; info?: TemplateInfo; image?: string };
const renderName = /^([0-9a-f]{64})\.jpg$/;

/** Loads a template in the renderer and returns its declarations, or throws TemplateImportError. */
export type ValidateTemplate = (folder: string) => Promise<TemplateInfo>;
export type BuiltIn = { template: string; sample?: string; defaultName?: string };
export type ImportPlan = (
  | { kind: 'new' | 'newer' | 'same'; info: TemplateInfo; current?: LibraryEntry }
  | { kind: 'changed' | 'older'; info: TemplateInfo; current: LibraryEntry }
) & { hash: string; packages: TemplatePackage[] };
export type ImportResult = LibraryImportResult;
export type ResolvedTemplate = Awaited<ReturnType<TemplateLibrary['resolve']>>;

function entryFrom(info: TemplateInfo | undefined, fallback: { id: string; version?: string }, extra: Omit<LibraryEntry,
  'id' | 'version' | 'label' | 'formats' | 'layouts' | 'openingSpreads'>): LibraryEntry {
  const geometry = info && resolveFormat(info.format);
  return {
    id: info?.id ?? fallback.id, version: info?.version ?? fallback.version ?? '', label: info?.label ?? info?.id ?? fallback.id,
    ...(info?.description ? { description: info.description } : {}),
    ...(info?.network?.length ? { network: [...info.network] } : {}),
    formats: info ? Object.values(info.formats).length ? Object.values(info.formats) : [info.format.label] : [],
    ...(geometry ? { shape: geometry.pageWidth === geometry.height ? 'Square' as const : geometry.pageWidth > geometry.height ? 'Landscape' as const : 'Portrait' as const } : {}),
    layouts: info ? Object.values(info.spreads).map(({ label }) => label) : [],
    openingSpreads: info?.openingSpreads?.length ?? 0,
    ...(geometry ? { aspect: trimAspect(info.format) } : {}),
    ...extra,
  };
}

export class TemplateLibrary {
  private builtIns = new Map<string, Found & { sample?: string; defaultName?: string }>();
  private builtInsLoaded?: Promise<void>;
  private listeners = new Set<() => void>();
  private writes = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly builtInSources: BuiltIn[],
    private readonly validate: ValidateTemplate,
    private readonly trash: (path: string) => Promise<void>,
    private readonly capabilities: string,
    private readonly authoringTypes?: string,
    private readonly renders?: RenderFolders,
  ) {}

  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }

  // Built-in templates ship with the app; they are validated once per launch, since an update can change them.
  private loadBuiltIns() {
    this.builtInsLoaded ??= (async () => {
      for (const source of this.builtInSources) {
        const hash = await templateHash(source.template).catch(() => '');
        let info: TemplateInfo | undefined;
        let problem: string | undefined;
        try { info = await this.validate(source.template); }
        catch (error) { problem = error instanceof Error ? error.message : String(error); }
        const id = info?.id ?? 'built-in-' + this.builtIns.size;
        const packages = await templatePackages(source.template);
        const { image } = await this.previewImage(source.template, info);
        this.builtIns.set(id, { folder: source.template, info, image, sample: source.sample, defaultName: source.defaultName,
          entry: entryFrom(info, { id }, { source: 'built-in', hash, ...(packages.length ? { packages } : {}), ...(source.sample ? { sample: true } : {}),
            ...(problem ? { unavailable: problem } : {}) }) });
      }
      // Renders of earlier versions of the built-in templates are no longer shown.
      const current = new Set([...this.builtIns.values()].map(({ entry }) => entry.hash));
      if (this.renders) for (const name of await readdir(this.renders.cache).catch(() => [])) {
        const hash = renderName.exec(name)?.[1];
        if (hash && !current.has(hash)) await rm(join(this.renders.cache, name), { force: true }).catch(() => {});
      }
    })();
    return this.builtInsLoaded;
  }

  // The template's own preview image as the library shows it: its path in the template folder, or why it cannot be shown.
  private async previewImage(folder: string, info: TemplateInfo | undefined): Promise<{ image?: string; imageProblem?: string }> {
    if (!info?.preview) return {};
    const report = await readTemplatePreview(folder, info.preview);
    return 'problem' in report ? { imageProblem: report.problem } : { image: info.preview };
  }

  // The saved render of an entry's opening spread, if there is one.
  private async savedRender(found: Found, imported: boolean) {
    const { hash } = found.entry;
    if (!hash) return undefined;
    const candidates = imported ? [join(dirname(found.folder), 'preview-' + hash + '.jpg')]
      : this.renders ? [...this.renders.shipped ? [join(this.renders.shipped, hash + '.jpg')] : [], join(this.renders.cache, hash + '.jpg')] : [];
    for (const file of candidates) if (await lstat(file).then((entry) => entry.isFile(), () => false)) return file;
    return undefined;
  }

  // The pictures an entry has, for the New Book picker and the Templates window to show at once.
  private async withPictures(found: Found, imported: boolean): Promise<LibraryEntry> {
    const render = await this.savedRender(found, imported);
    return { ...found.entry, ...(found.image ? { image: true } : {}), ...(render ? { render: true } : {}) };
  }

  private async readMetadata(id: string): Promise<Metadata | undefined> {
    try {
      const value = JSON.parse(await readFile(join(this.root, id, 'library.json'), 'utf8')) as Metadata;
      return value?.schema === 1 && typeof value.hash === 'string' ? value : undefined;
    } catch { return undefined; }
  }

  private async userEntries() {
    const names = await readdir(this.root, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const entries: Found[] = [];
    for (const name of names) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue;
      const folder = join(this.root, name.name, 'template');
      const cached = await this.readMetadata(name.name);
      let metadata: Metadata;
      // A missing or outdated cache is rebuilt from the source, with the same checks as an import.
      if (cached && cached.capabilities === this.capabilities) metadata = cached;
      else {
        const base: Metadata = { schema: 1, hash: '', importedAt: new Date().toISOString(), ...cached, capabilities: this.capabilities };
        try {
          const { hash, info } = await this.describe(folder);
          metadata = { ...base, hash, info, problem: undefined, image: undefined, imageProblem: undefined, ...await this.previewImage(folder, info) };
        } catch (error) {
          metadata = { ...base, info: undefined, problem: error instanceof Error ? error.message : String(error), image: undefined, imageProblem: undefined };
        }
        await writeFile(join(this.root, name.name, 'library.json'), JSON.stringify(metadata, null, 2) + '\n').catch(() => {});
      }
      const packages = await templatePackages(folder);
      entries.push({ folder, info: metadata.info, ...(metadata.image ? { image: metadata.image } : {}), entry: entryFrom(metadata.info, { id: name.name }, {
        source: 'imported', hash: metadata.hash, importedAt: metadata.importedAt, ...(packages.length ? { packages } : {}),
        ...(metadata.importedFrom ? { importedFrom: metadata.importedFrom } : {}),
        ...(metadata.problem ? { unavailable: metadata.problem } : {}),
      }) });
    }
    return entries;
  }

  private async describe(folder: string) {
    const files = await templateFiles(folder);
    const [hash, info] = await Promise.all([templateHash(folder, files), this.validate(folder)]);
    return { hash, info, files };
  }

  /** Whether a template with this hash ships with the app. */
  async isBuiltIn(hash: string) {
    return (await this.builtInNetwork(hash)) !== undefined;
  }

  /** The network origins a built-in template with this hash declares, or undefined when no built-in has the hash. */
  async builtInNetwork(hash: string) {
    await this.loadBuiltIns();
    const found = hash ? [...this.builtIns.values()].find(({ entry }) => entry.hash === hash) : undefined;
    return found ? found.entry.network ?? [] : undefined;
  }

  /** Every template a book can be created from: built-ins, replaced by an imported template with the same ID. */
  async list(): Promise<LibraryEntry[]> {
    await this.writes;
    await this.loadBuiltIns();
    const user = await this.userEntries();
    const ids = new Set(user.map(({ entry }) => entry.id));
    const builtIns = await Promise.all([...this.builtIns.values()].filter(({ entry }) => !ids.has(entry.id)).map((found) => this.withPictures(found, false)));
    const imported = await Promise.all(user.map(async (found) => {
      const entry = await this.withPictures(found, true);
      return this.builtIns.has(entry.id) ? { ...entry, replacesBuiltIn: true } : entry;
    }));
    return [...builtIns, ...imported.sort((a, b) => a.label.localeCompare(b.label))];
  }

  /**
   * The file of a picture of the entry with this hash: the template's own preview `image`, or the saved `render` of its
   * opening spread. Undefined when the entry has none or no entry has the hash.
   */
  async pictureFile(hash: string, kind: 'image' | 'render') {
    await this.writes;
    await this.loadBuiltIns();
    const user = (await this.userEntries()).find(({ entry }) => entry.hash === hash);
    const found = user ?? [...this.builtIns.values()].find(({ entry }) => entry.hash === hash);
    if (!found || !hash) return undefined;
    if (kind === 'render') return this.savedRender(found, !!user);
    return found.image ? join(found.folder, ...found.image.split('/')) : undefined;
  }

  /**
   * Saves a render of the opening spread of the entry with this hash, so later launches show it at once. Nothing is
   * saved when no entry has the hash any more, for example because the template was replaced while it rendered.
   */
  async saveRender(hash: string, bytes: Uint8Array) {
    const task = this.writes.then(async () => {
      await this.loadBuiltIns();
      const user = (await this.userEntries()).find(({ entry }) => entry.hash === hash);
      const builtIn = [...this.builtIns.values()].some(({ entry }) => entry.hash === hash);
      const file = user ? join(dirname(user.folder), 'preview-' + hash + '.jpg') : builtIn && this.renders ? join(this.renders.cache, hash + '.jpg') : undefined;
      if (!file || !hash) return false;
      await mkdir(dirname(file), { recursive: true });
      // Written aside and renamed, so a picture is never read half-written.
      const partial = file + '.' + randomUUID() + '.partial';
      try {
        await writeFile(partial, bytes);
        await rename(partial, file);
      } finally { await rm(partial, { force: true }); }
      return true;
    });
    this.writes = task.then(() => {}, () => {});
    return task;
  }

  /** Where a usable entry's template source is, with its declarations and, for a built-in, its sample book. */
  async resolve(id: string) {
    await this.writes;
    return this.resolveNow(id);
  }

  /**
   * Runs `use` with an entry while no import or removal can change the library, so whatever `use` copies from
   * `folder` matches the version, hash and declarations it is given, even if the entry is replaced meanwhile.
   */
  async withTemplate<T>(id: string, use: (template: ResolvedTemplate) => Promise<T>): Promise<T> {
    const task = this.writes.then(async () => use(await this.resolveNow(id)));
    this.writes = task.then(() => {}, () => {});
    return task;
  }

  private async resolveNow(id: string) {
    await this.loadBuiltIns();
    const user = (await this.userEntries()).find(({ entry }) => entry.id === id);
    const builtIn = this.builtIns.get(id);
    const found = user ?? builtIn;
    if (!found || !found.info || found.entry.unavailable) throw new Error(found?.entry.unavailable ?? 'This template is no longer in the library.');
    return { entry: found.entry, folder: found.folder, info: found.info,
      sample: user ? undefined : builtIn?.sample, defaultName: user ? undefined : builtIn?.defaultName };
  }

  /**
   * Validates a template folder and says how importing it relates to the entry with the same ID. Nothing is written.
   * A template that fails to load throws TemplateImportError with the app's diagnostics.
   */
  async plan(source: string): Promise<ImportPlan> {
    const { hash, info } = await this.describe(source);
    if (!info.id) throw new TemplateImportError('The template did not report its ID.');
    const packages = await templatePackages(source);
    const current = (await this.list()).find((entry) => entry.id === info.id);
    if (!current) return { kind: 'new', info, hash, packages };
    if (current.hash === hash) return { kind: 'same', info, hash, current, packages };
    const order = compareVersions(info.version, current.version);
    return { kind: order > 0 ? 'newer' : order < 0 ? 'older' : 'changed', info, hash, current, packages } as ImportPlan;
  }

  /**
   * Imports a template folder or an `.imageflow-template` file. `confirm` decides when the import would replace an
   * entry with the same or a later version. `review`, when given, sees every import that would change the library,
   * after `confirm`, so the user can see the packages and network access it brings (ADR 0006); false cancels it.
   * An entry it replaces goes to the Trash.
   */
  async import(source: string, confirm: (plan: ImportPlan) => Promise<boolean>, review?: (plan: ImportPlan) => Promise<boolean>): Promise<ImportResult> {
    if (!isTemplateArchive(source)) return this.importFolder(source, source, confirm, review);
    // A file is unpacked into a hidden folder of the library first, and imported from there like a folder.
    const unpacked = join(this.root, '.unpack-' + randomUUID());
    try {
      await mkdir(this.root, { recursive: true });
      await extractTemplateArchive(source, unpacked);
      return await this.importFolder(unpacked, source, confirm, review);
    } catch (error) {
      return { source, status: 'failed', message: error instanceof Error ? error.message : String(error),
        details: error instanceof TemplateImportError ? error.details : [] };
    } finally {
      await rm(unpacked, { recursive: true, force: true });
    }
  }

  private async importFolder(folder: string, source: string, confirm: (plan: ImportPlan) => Promise<boolean>,
    review?: (plan: ImportPlan) => Promise<boolean>): Promise<ImportResult> {
    let plan: ImportPlan;
    try { plan = await this.plan(folder); }
    catch (error) {
      return { source, status: 'failed', message: error instanceof Error ? error.message : String(error),
        details: error instanceof TemplateImportError ? error.details : [] };
    }
    const { info } = plan;
    const named = { id: info.id, label: info.label ?? info.id, version: info.version };
    if (plan.kind === 'same') return { source, status: 'unchanged', ...named };
    if ((plan.kind === 'changed' || plan.kind === 'older') && !await confirm(plan)) return { source, status: 'cancelled', ...named };
    if (review && !await review(plan)) return { source, status: 'cancelled', ...named };
    const replaced = !!plan.current && plan.current.source === 'imported';
    const task = this.writes.then(() => this.commit(folder, source, info, plan.hash));
    this.writes = task.catch(() => {});
    try { await task; }
    catch (error) {
      return { source, status: 'failed', ...named, message: error instanceof Error ? error.message : String(error),
        details: error instanceof TemplateImportError ? error.details : [] };
    }
    this.changed();
    return { source, status: replaced ? 'replaced' : 'imported', ...named };
  }

  // Copies into a staging folder inside the library, checks the copy again, and swaps it in. A failure leaves the
  // library as it was.
  private async commit(folder: string, source: string, info: TemplateInfo, hash: string) {
    const id = info.id!;
    await mkdir(this.root, { recursive: true });
    const staging = join(this.root, '.staging-' + randomUUID());
    try {
      const files = await copyTemplate(folder, join(staging, 'template'));
      // The source may have changed since it was validated; the copy is what the library keeps.
      if (await templateHash(join(staging, 'template'), files) !== hash) {
        throw new TemplateImportError('The template changed while it was being imported. Import it again.');
      }
      const metadata: Metadata = { schema: 1, capabilities: this.capabilities, hash, importedAt: new Date().toISOString(),
        importedFrom: source, info, ...await this.previewImage(join(staging, 'template'), info) };
      await writeFile(join(staging, 'library.json'), JSON.stringify(metadata, null, 2) + '\n');
      const target = join(this.root, id);
      const exists = await lstat(target).then(() => true, () => false);
      if (exists) {
        // Move the old entry aside first, so the new one is never mixed with it, then trash it.
        const old = join(this.root, '.replaced-' + randomUUID());
        await rename(target, old);
        await rename(staging, target);
        await this.trash(old).catch(() => rm(old, { recursive: true, force: true }));
      } else await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Writes a library entry, imported or built-in, to an `.imageflow-template` file. */
  async export(id: string, file: string) {
    await this.writes;
    await this.loadBuiltIns();
    const found = (await this.userEntries()).find(({ entry }) => entry.id === id) ?? this.builtIns.get(id);
    if (!found) throw new Error('This template is no longer in the library.');
    await writeTemplateArchive(found.folder, file, this.authoringTypes);
  }

  /** Moves an imported template to the Trash. Built-in templates cannot be removed. */
  async remove(id: string) {
    const task = this.writes.then(async () => {
      const user = (await this.userEntries()).find(({ entry }) => entry.id === id);
      if (!user) throw new Error(this.builtIns.has(id) ? 'Built-in templates cannot be removed.' : 'This template is no longer in the library.');
      await this.trash(join(this.root, id));
    });
    this.writes = task.catch(() => {});
    await task;
    this.changed();
  }
}

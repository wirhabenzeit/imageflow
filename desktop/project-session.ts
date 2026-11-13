import { randomUUID } from 'node:crypto';
import type { ProjectFiles } from '../src/project';
import type { HistoryState } from '../src/desktop';
import { isGeneratedFile, removeGeneratedFiles, unreferencedGeneratedFiles, updateProject } from './project';
import type { OpenProject } from './project';
import { ProjectInputIndex } from './revisions';
import { CheckRenditionCache } from './check-cache';

type Entry = { files: ProjectFiles; label: string };
const filesOf = (book: ProjectFiles): ProjectFiles => structuredClone({ project: book.project, photoIndex: book.photoIndex });
const same = (a: ProjectFiles, b: ProjectFiles) => JSON.stringify(a.project) === JSON.stringify(b.project) &&
  JSON.stringify(a.photoIndex) === JSON.stringify(b.photoIndex);

/** One app-owned history shared by UI saves, agent batches and imports onto a spread. */
export class ProjectSession {
  readonly handle = randomUUID();
  inputs: ProjectInputIndex;
  readonly renditions = new CheckRenditionCache();
  private past: Entry[] = [];
  private future: Entry[] = [];
  readonly receipts = new Map<string, { request: string; result: Record<string, unknown> }>();
  // Told which files collection deletes, so the book watcher does not take the deletion for an outside change.
  removing?: (paths: string[]) => Promise<void> | void;
  constructor(public book: OpenProject) {
    this.inputs = new ProjectInputIndex(book.folder);
  }

  relocate(folder: string) {
    this.inputs.close();
    this.inputs = new ProjectInputIndex(folder);
  }

  close() {
    this.inputs.close();
    return this.renditions.close();
  }

  private invalidateManifests(book: ProjectFiles) {
    if (JSON.stringify(this.book.project) !== JSON.stringify(book.project)) this.inputs.invalidate('project.json');
    if (JSON.stringify(this.book.photoIndex) !== JSON.stringify(book.photoIndex)) this.inputs.invalidate('photos.json');
  }

  get history(): HistoryState {
    return { undo: this.past.at(-1)?.label, redo: this.future.at(-1)?.label };
  }

  adoptExternal(book: OpenProject) {
    if (!same(this.book, book)) {
      this.invalidateManifests(book);
      this.past = [];
      this.future = [];
    }
    this.book = book;
  }

  record(book: OpenProject, label: string, undoable = true) {
    if (undoable && !same(this.book, book)) {
      this.past.push({ files: filesOf(this.book), label: label.slice(0, 160) || 'Project edit' });
      if (this.past.length > 100) this.past.shift();
      this.future = [];
    }
    this.invalidateManifests(book);
    this.book = book;
  }

  async save(files: ProjectFiles, label: string, base = this.book) {
    const next = await updateProject(base, files);
    this.adoptExternal(base);
    this.record(next, label);
    return this.collectGenerated();
  }

  /** Deletes generated files (ADR 0006) that neither the current state nor any Undo/Redo state refers to. Jobs that
   * are running read pinned snapshots, so they are unaffected. Collection is not an undoable step. */
  async collectGenerated(retainHistory = true) {
    if (this.book.readOnly) return this.book;
    const retained = retainHistory ? [...this.past, ...this.future].map(({ files }) => files.project) : [];
    const ids = unreferencedGeneratedFiles(this.book.project, retained);
    if (!ids.length) return this.book;
    const paths = ids.map((id) => this.book.project.files[id]).filter((ref): ref is string => typeof ref === 'string');
    await this.removing?.(paths);
    const { book } = await removeGeneratedFiles(this.book, ids);
    this.invalidateManifests(book);
    this.book = book;
    return book;
  }

  async undo(direction: 'undo' | 'redo') {
    const [source, destination] = direction === 'undo' ? [this.past, this.future] : [this.future, this.past];
    const entry = source.at(-1);
    if (!entry) return this.book;
    const files = filesOf(entry.files);
    // Keep registered sources, including file parameters, available to retained state and future Redo.
    files.project.texts = { ...files.project.texts, ...this.book.project.texts };
    files.project.files = { ...files.project.files, ...this.book.project.files };
    // Generated files already collected are gone; the state being restored never referred to them.
    for (const id of Object.keys(files.project.files)) {
      if (isGeneratedFile(id) && !Object.hasOwn(this.book.project.files, id)) delete files.project.files[id];
    }
    files.photoIndex = { ...this.book.photoIndex, ...files.photoIndex };
    for (const [id, current] of Object.entries(this.book.photoIndex)) {
      if (!files.photoIndex[id]) continue;
      files.photoIndex[id].path = current.path;
      if (current.linked) files.photoIndex[id].linked = true; else delete files.photoIndex[id].linked;
    }
    const next = await updateProject(this.book, files, true);
    source.pop();
    destination.push({ files: filesOf(this.book), label: entry.label });
    this.invalidateManifests(next);
    this.book = next;
    return this.collectGenerated();
  }
}

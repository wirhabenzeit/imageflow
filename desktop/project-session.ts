import { randomUUID } from 'node:crypto';
import type { ProjectFiles } from '../src/project';
import type { HistoryState } from '../src/desktop';
import { updateProject } from './project';
import type { OpenProject } from './project';
import { ProjectInputIndex } from './revisions';
import { CheckRenditionCache } from './check-cache';

type Membership = { photos: string[]; texts: string[]; files: string[] };
type Entry = { files: ProjectFiles; label: string; membership?: Membership };
const changedKeys = (before: object, after: object) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((id) => Object.hasOwn(before, id) !== Object.hasOwn(after, id));
const filesOf = (book: ProjectFiles): ProjectFiles => structuredClone({ project: book.project, photoIndex: book.photoIndex });
const same = (a: ProjectFiles, b: ProjectFiles) => JSON.stringify(a.project) === JSON.stringify(b.project) &&
  JSON.stringify(a.photoIndex) === JSON.stringify(b.photoIndex);

/** One app-owned history shared by UI saves, agent batches and imports onto a spread. */
export class ProjectSession {
  readonly handle = randomUUID();
  inputs: ProjectInputIndex;
  readonly renditions = new CheckRenditionCache();
  private past: Entry[] = [];
  private opened: ProjectFiles;
  private future: Entry[] = [];
  readonly receipts = new Map<string, { request: string; result: Record<string, unknown> }>();
  constructor(public book: OpenProject) {
    this.inputs = new ProjectInputIndex(book.folder);
    this.opened = filesOf(book);
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

  record(book: OpenProject, label: string, undoable = true, preserveSources = true) {
    if (undoable && !same(this.book, book)) {
      const membership = preserveSources ? undefined : {
        photos: changedKeys(this.book.photoIndex, book.photoIndex),
        texts: changedKeys(this.book.project.texts, book.project.texts),
        files: changedKeys(this.book.project.files, book.project.files),
      };
      this.past.push({ files: filesOf(this.book), membership, label: label.slice(0, 160) || 'Project edit' });
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
    return next;
  }

  async revertOpened() {
    const files = filesOf(this.opened);
    files.project.texts = { ...files.project.texts, ...this.book.project.texts };
    files.project.files = { ...files.project.files, ...this.book.project.files };
    files.photoIndex = { ...this.book.photoIndex, ...files.photoIndex };
    for (const [id, current] of Object.entries(this.book.photoIndex)) {
      if (!files.photoIndex[id]) continue;
      files.photoIndex[id].path = current.path;
      if (current.linked) files.photoIndex[id].linked = true; else delete files.photoIndex[id].linked;
    }
    const next = await updateProject(this.book, files, true);
    this.record(next, 'Revert to Last Opened');
    return next;
  }

  async undo(direction: 'undo' | 'redo') {
    const [source, destination] = direction === 'undo' ? [this.past, this.future] : [this.future, this.past];
    const entry = source.at(-1);
    if (!entry) return this.book;
    const files = filesOf(entry.files);
    // Keep registered sources, including file parameters, available to retained state and future Redo.
    files.project.texts = { ...files.project.texts, ...this.book.project.texts };
    files.project.files = { ...files.project.files, ...this.book.project.files };
    files.photoIndex = { ...this.book.photoIndex, ...files.photoIndex };
    for (const [id, current] of Object.entries(this.book.photoIndex)) {
      if (!files.photoIndex[id]) continue;
      files.photoIndex[id].path = current.path;
      if (current.linked) files.photoIndex[id].linked = true; else delete files.photoIndex[id].linked;
    }
    // Replay only this action's membership changes; later imports and non-undoable location repairs survive.
    for (const id of entry.membership?.photos ?? []) if (!Object.hasOwn(entry.files.photoIndex, id)) delete files.photoIndex[id];
    for (const kind of ['texts', 'files'] as const) for (const id of entry.membership?.[kind] ?? []) {
      if (!Object.hasOwn(entry.files.project[kind], id)) delete files.project[kind][id];
    }
    const next = await updateProject(this.book, files, true);
    source.pop();
    destination.push({ files: filesOf(this.book), label: entry.label, membership: entry.membership });
    this.invalidateManifests(next);
    this.book = next;
    return next;
  }
}

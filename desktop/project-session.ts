import { randomUUID } from 'node:crypto';
import type { ProjectFiles } from '../src/project';
import type { HistoryState } from '../src/desktop';
import { updateProject } from './project';
import type { OpenProject } from './project';

type Entry = { files: ProjectFiles; label: string };
const filesOf = (book: ProjectFiles): ProjectFiles => structuredClone({ project: book.project, photoIndex: book.photoIndex });
const same = (a: ProjectFiles, b: ProjectFiles) => JSON.stringify(a.project) === JSON.stringify(b.project) &&
  JSON.stringify(a.photoIndex) === JSON.stringify(b.photoIndex);

/** One app-owned history shared by UI saves, agent batches and imports onto a spread. */
export class ProjectSession {
  readonly handle = randomUUID();
  private past: Entry[] = [];
  private future: Entry[] = [];
  readonly receipts = new Map<string, { request: string; result: Record<string, unknown> }>();
  constructor(public book: OpenProject) {}

  get history(): HistoryState {
    return { undo: this.past.at(-1)?.label, redo: this.future.at(-1)?.label };
  }

  adoptExternal(book: OpenProject) {
    if (!same(this.book, book)) {
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
    this.book = book;
  }

  async save(files: ProjectFiles, label: string, base = this.book) {
    const next = await updateProject(base, files);
    this.adoptExternal(base);
    this.record(next, label);
    return next;
  }

  async undo(direction: 'undo' | 'redo') {
    const [source, destination] = direction === 'undo' ? [this.past, this.future] : [this.future, this.past];
    const entry = source.at(-1);
    if (!entry) return this.book;
    const files = filesOf(entry.files);
    // Keep registered sources, including file parameters, available to retained state and future Redo.
    files.project.texts = { ...this.book.project.texts, ...files.project.texts };
    files.project.files = { ...this.book.project.files, ...files.project.files };
    files.photoIndex = { ...this.book.photoIndex, ...files.photoIndex };
    const next = await updateProject(this.book, files, true);
    source.pop();
    destination.push({ files: filesOf(this.book), label: entry.label });
    this.book = next;
    return next;
  }
}

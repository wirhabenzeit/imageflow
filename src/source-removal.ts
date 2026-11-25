import { clearFileAssignments } from './asset-usage';
import { coverInstance, storedBoxes } from './project';
import type { ProjectFiles, SpreadState } from './project';

export type RemovedSource = { kind: 'photo' | 'markdown' | 'file'; id: string };

/** The layouts a book stores content in: its spreads and, as one more, its cover. */
export function storedLayouts({ cover, spreads }: ProjectFiles['project']): SpreadState[] {
  return cover ? [...spreads, { ...cover, id: coverInstance }] : spreads;
}

/**
 * Takes sources out of a book's manifests, in place, with every use of them: boxes, shown or set aside, with the crops
 * and focus of a photo, and the parameters a file is assigned to. Their files are the caller's.
 */
export function removeFromBook(files: ProjectFiles, sources: readonly RemovedSource[]) {
  const layouts = storedLayouts(files.project);
  clearFileAssignments(files.project, sources.filter(({ kind }) => kind === 'file').map(({ id }) => id));
  const gone = { photo: new Set<string>(), markdown: new Set<string>(), file: new Set<string>() };
  for (const { kind, id } of sources) {
    gone[kind].add(id);
    if (kind === 'photo') delete files.photoIndex[id];
    else delete files.project[kind === 'markdown' ? 'texts' : 'files'][id];
  }
  if (!gone.photo.size && !gone.markdown.size) return;
  // Every box the spread stores, on its pages too. A photo's crops and focus go with it; replaced content that held the
  // source has nothing left to set aside, so its entry goes.
  for (const layout of layouts) {
    for (const { state } of storedBoxes(layout)) {
      if (state.photo && gone.photo.has(state.photo)) { delete state.photo; delete state.crops; delete state.focus; }
      if (state.text && gone.markdown.has(state.text)) delete state.text;
    }
    if (layout.displaced) {
      layout.displaced = layout.displaced.filter(({ state }) => state.photo || state.text);
      if (!layout.displaced.length) delete layout.displaced;
    }
  }
}

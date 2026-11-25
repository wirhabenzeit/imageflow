import { canonicalJson } from './canonical-json';
import type { Project } from './project';

/**
 * What a sync pull changed, for the book history (API-015 of 25 November, evening): an entry that only says "Sync pull" left
 * an agent to compare spread IDs, and did not say that the template was replaced.
 */
export type PullChanges = {
  spreads: { added: number; removed: number; changed: number };
  /** Template, text and other files written or removed, by their path in the book. */
  files: string[];
};

export function pullChanges(before: Project, after: Project, files: readonly string[]): PullChanges {
  const old = new Map(before.spreads.map((spread) => [spread.id, canonicalJson(spread)]));
  const next = new Set(after.spreads.map(({ id }) => id));
  return {
    spreads: {
      added: after.spreads.filter(({ id }) => !old.has(id)).length,
      removed: before.spreads.filter(({ id }) => !next.has(id)).length,
      changed: after.spreads.filter((spread) => old.has(spread.id) && old.get(spread.id) !== canonicalJson(spread)).length,
    },
    files: [...files].sort(),
  };
}

/** "Sync pull: 11 spreads added, 3 removed, 2 changed; 2 template files, 1 text". */
export function pullLabel({ spreads, files }: PullChanges) {
  const counts = ([['added', spreads.added], ['removed', spreads.removed], ['changed', spreads.changed]] as const).filter(([, count]) => count)
    .map(([what, count], i) => (i ? String(count) : count + (count === 1 ? ' spread' : ' spreads')) + ' ' + what).join(', ');
  const of = (folder: string, noun: string) => {
    const count = files.filter((path) => path.startsWith(folder + '/')).length;
    return count ? count + ' ' + noun + (count === 1 ? '' : 's') : '';
  };
  const parts = [counts, [of('template', 'template file'), of('texts', 'text'), of('files', 'file')].filter(Boolean).join(', ')].filter(Boolean);
  return 'Sync pull' + (parts.length ? ': ' + parts.join('; ') : '');
}

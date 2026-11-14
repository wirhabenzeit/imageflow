import type { ProjectSummary } from './desktop';

export type PhotoView = { sort: 'capture' | 'name' | 'import'; group: 'none' | 'day' | 'gap'; gapMinutes: number; showTime: boolean };
export const defaultPhotoView: PhotoView = { sort: 'capture', group: 'none', gapMinutes: 120, showTime: false };
export const photoViewCommands = ['photos-sort-capture', 'photos-sort-name', 'photos-sort-import', 'photos-group-none', 'photos-group-day',
  'photos-gap-30', 'photos-gap-120', 'photos-gap-360', 'photos-gap-custom', 'photos-show-time'] as const;
export type PhotoViewCommand = typeof photoViewCommands[number];
export const isPhotoViewCommand = (id: string): id is PhotoViewCommand => (photoViewCommands as readonly string[]).includes(id);
export function validPhotoView(value: unknown): PhotoView {
  const saved = value as Partial<PhotoView> | null;
  return { sort: ['capture', 'name', 'import'].includes(saved?.sort ?? '') ? saved!.sort! : defaultPhotoView.sort,
    group: ['none', 'day', 'gap'].includes(saved?.group ?? '') ? saved!.group! : 'none',
    gapMinutes: Number.isFinite(saved?.gapMinutes) && saved!.gapMinutes! >= 1 && saved!.gapMinutes! <= 10080 ? saved!.gapMinutes! : 120,
    showTime: saved?.showTime === true };
}
export function photoViewChange(id: PhotoViewCommand, current: PhotoView): Partial<PhotoView> {
  if (id.startsWith('photos-sort-')) return { sort: id.slice(12) as PhotoView['sort'] };
  if (id === 'photos-group-none' || id === 'photos-group-day') return { group: id.endsWith('day') ? 'day' : 'none' };
  if (id === 'photos-show-time') return { showTime: !current.showTime };
  if (id === 'photos-gap-custom') return {};
  return { group: 'gap', gapMinutes: Number(id.slice(11)) };
}
export function photoDate(summary: ProjectSummary, id: string) {
  return summary.photoDates?.[id] ?? summary.photoIndex[id];
}
export function captureWallTime(captured?: string, estimated = false) {
  if (!captured) return undefined;
  if (!estimated) return captured.slice(0, 19);
  // File mtimes are instants. Show them in the computer's local timezone; camera dates keep their as-shot wall
  // time even when an offset is present. Retain the original instant in saved metadata for portability.
  const date = new Date(captured);
  if (!Number.isFinite(date.valueOf())) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}
export function captureMillis(captured?: string, estimated = false) {
  const wall = captureWallTime(captured, estimated);
  const value = wall && Date.parse(wall + 'Z');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function orderedPhotos(summary: ProjectSummary, view: PhotoView = defaultPhotoView) {
  const ids = Object.keys(summary.photoIndex);
  if (view.sort === 'import') return ids;
  return ids.sort((a, b) => {
    if (view.sort === 'capture') {
      const leftDate = photoDate(summary, a), rightDate = photoDate(summary, b);
      const left = captureMillis(leftDate?.captured, leftDate?.capturedEstimated), right = captureMillis(rightDate?.captured, rightDate?.capturedEstimated);
      if (left !== undefined || right !== undefined) return left === undefined ? 1 : right === undefined ? -1 : left - right;
      return 0; // Import order is the stable fallback for undated photos.
    }
    const name = (id: string) => summary.photoIndex[id].title || summary.photoIndex[id].path.split('/').pop() || id;
    return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' });
  });
}
export type PhotoGroup = { id: string; label: string; ids: string[]; total: number };
export function photoGroups(summary: ProjectSummary, ids: string[], view: PhotoView): PhotoGroup[] {
  if (view.group === 'none') return [{ id: 'all', label: '', ids, total: ids.length }];
  const all = orderedPhotos(summary, view);
  const groups: PhotoGroup[] = [];
  const byDay = new Map<string, PhotoGroup>();
  let previous: number | undefined;
  let gap: PhotoGroup | undefined;
  const undated: string[] = [];
  for (const id of all) {
    const date = photoDate(summary, id);
    const captured = captureWallTime(date?.captured, date?.capturedEstimated), time = captureMillis(captured);
    if (!captured || time === undefined) { undated.push(id); continue; }
    const day = captured.slice(0, 10);
    const label = new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    let group: PhotoGroup;
    if (view.group === 'day') {
      group = byDay.get(day) ?? { id: day, label, ids: [], total: 0 };
      if (!byDay.has(day)) { byDay.set(day, group); groups.push(group); }
    } else {
      if (!gap || previous === undefined || Math.abs(time - previous) > view.gapMinutes * 60000) {
        gap = { id: 'gap-' + id, label: label + ' · ' + captured.slice(11, 16), ids: [], total: 0 }; groups.push(gap);
      }
      group = gap;
    }
    group.ids.push(id); group.total++; previous = time;
  }
  if (undated.length) groups.push({ id: 'undated', label: 'No date', ids: undated, total: undated.length });
  const shown = new Set(ids);
  return groups.map((group) => ({ ...group, ids: group.ids.filter((id) => shown.has(id)) })).filter((group) => group.ids.length > 0);
}
export function captureLabel(captured?: string, estimated = false) {
  const wall = captureWallTime(captured, estimated);
  if (!wall || captureMillis(wall) === undefined) return '';
  return new Date(wall + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}
export function captureFact(date?: { captured?: string; capturedEstimated?: boolean }) {
  const wall = captureWallTime(date?.captured, date?.capturedEstimated);
  if (!date || !wall || captureMillis(wall) === undefined) return undefined;
  const estimated = date.capturedEstimated;
  const value = new Date(wall + 'Z').toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(!estimated ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } as const : {}),
  });
  return { label: estimated ? 'Modified' : 'Captured', value,
    title: estimated ? 'Estimated from file modification time' : date.captured };
}

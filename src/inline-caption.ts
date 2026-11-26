import { captionEdit } from './CaptionField';
import type { ProjectSummary } from './desktop';
import type { SourceUsage } from './editing';
import { editableSpread } from './page-editor';
import type { Parameters } from './parameters';
import type { PageSide, Project, ProjectFiles } from './project';

// Typing a photo's caption where ctx.Caption prints it (UI-019). The caption is the photo's, so it is read from and
// saved to the photo's entry, exactly as Edit Caption… saves it; the box only says which photo, and its Show caption
// switch, which the first caption turns on (UI-014). The inline text editor types it as a multiline plain string
// (`captionParameter` in inline-text.ts, which the render frame shares without this module's app imports).

type CaptionFiles = Pick<ProjectSummary, 'photoIndex' | 'photoProvided'>;

/** The caption a template prints for a photo: the book's own where photos.json has one (even empty), else its provider's. */
export function printedCaption(files: CaptionFiles, photo: string) {
  const entry = Object.hasOwn(files.photoIndex, photo) ? files.photoIndex[photo] : undefined;
  if (!entry) return '';
  return (Object.hasOwn(entry, 'caption') ? entry.caption : files.photoProvided?.[photo]?.caption) ?? '';
}

/** Where a caption is typed: a photo box of a spread, or of one page of a sheet shown as pages, in the layout it showed. */
export type CaptionPlace = { spread: string; page?: PageSide; box: string; layout: string };

/** The photo a box shows, while the spread still shows the layout it was opened in. */
export function captionPhoto(project: Project, at: CaptionPlace) {
  const state = editableSpread(project.spreads.find(({ id }) => id === at.spread), at.page);
  return state?.definition === at.layout && Object.hasOwn(state.boxes, at.box) ? state.boxes[at.box].photo : undefined;
}

/**
 * Saves a typed caption when the shared save queue runs, as one Undo step, only while nothing it was typed over has
 * changed: the box still shows the same photo in the same layout, and the photo's caption is still the one typing
 * started from. Otherwise it saves nothing and returns false, so newer saved text is never overwritten.
 */
export function saveInlineCaption(files: ProjectFiles, summary: CaptionFiles, at: CaptionPlace, parameters: Parameters | undefined,
  photo: string, before: string, value: string) {
  if (captionPhoto(files.project, at) !== photo || !Object.hasOwn(files.photoIndex, photo)) return false;
  if (printedCaption({ photoIndex: files.photoIndex, photoProvided: summary.photoProvided }, photo) !== before) return false;
  captionEdit(summary, photo, value, parameters && { parameters, find: ({ project }) => {
    const state = editableSpread(project.spreads.find(({ id }) => id === at.spread), at.page);
    return state?.definition === at.layout ? state.boxes[at.box] : undefined;
  } })(files);
  return true;
}

/**
 * Where else the photo is placed, for the hint beside a caption being typed, as a caption changes it there too: "Also
 * on p. 12", "Also on pp. 6–7, p. 12 and the cover". Undefined when this is its only place.
 */
export function captionElsewhere(usage: SourceUsage, photo: string, spread: string) {
  const places = (usage.photo[photo] ?? []).filter((place) => place.spread !== spread)
    .map((place) => place.cover ? 'the cover' : (place.pages.includes('–') ? 'pp. ' : 'p. ') + place.pages);
  if (!places.length) return undefined;
  const shown = places.length > 4 ? [...places.slice(0, 3), (places.length - 3) + ' more places'] : places;
  return 'Also on ' + (shown.length > 1 ? shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1) : shown[0]);
}

import type { ProjectSummary, TemplateInfo } from './desktop';
import { storedStates } from './project';
import type { SpreadState } from './project';
import { layoutFootprint, shownLayoutStates } from './layouts';

// Layout previews read the selected spread's content, document parameters, pagination, book anchors and the book
// index (`ctx.book.spreads`: every shown page's layout and placed photos with their metadata), and book credits.
// Render-session URLs, document metadata and other layouts' content apart from anchors/credits do not affect it.
export function layoutPreviewKey(summary: ProjectSummary, template: TemplateInfo, spread: SpreadState) {
  const placed = (item: SpreadState) => shownLayoutStates(item).flatMap(({ page, state }) =>
    Object.entries(state.boxes).flatMap(([box, { photo }]) => photo ? [[page, box, photo] as const] : []));
  // A candidate layout can restore the selected sheet's remembered content, including its hidden spread state.
  const selectedStates = storedStates(spread);
  const photos = [...new Set([...selectedStates.flatMap(({ state }) => Object.values(state.boxes).flatMap(({ photo }) => photo ? [photo] : [])),
    ...summary.project.spreads.flatMap((item) => placed(item).map(([, , photo]) => photo))])].sort();
  const texts = [...new Set(selectedStates.flatMap(({ state }) =>
    Object.values(state.boxes).flatMap((box) => box.text ? [box.text] : [])))].sort();
  return JSON.stringify([
    summary.folder, summary.templateHash ?? summary.id, summary.network ?? [], template.format,
    spread, summary.project.params,
    summary.project.spreads.map((item) => {
      // A hidden spread layout affects neither the index nor anchors/credits. Preserve page identity, including
      // missing blank pages through `split`, and the sheet footprint that determines every later page number.
      return [item.id, !!item.split, layoutFootprint(item, template.spreads), shownLayoutStates(item).map(({ page, state }) => {
        const layout = template.spreads[state.definition];
        return [page, state.definition, layout?.span, layout?.declaresAnchors || layout?.declaresCredits ? state.params : null,
          layout?.declaresCredits ? [state.elements, state.boxes] : null];
      }), placed(item)];
    }),
    photos.map((id) => {
      const photo = summary.photoIndex[id];
      const source = summary.sources?.['photo:' + id];
      return [id, !!summary.photos[id], summary.photoSizes[id], photo?.title, photo?.caption, photo?.credit, photo?.altText,
        summary.photoRevisions?.[id] ?? source?.digest ?? summary.id, source?.state];
    }),
    texts.map((id) => [id, summary.texts[id]]),
    // file(id) can read any registered file, including one not assigned to the current layout.
    Object.entries(summary.project.files).map(([id, file]) => [id, file, summary.sources?.['file:' + id]?.digest ?? summary.id]),
  ]);
}

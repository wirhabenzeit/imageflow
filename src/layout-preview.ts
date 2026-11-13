import type { ProjectSummary, TemplateInfo } from './desktop';
import type { SpreadState } from './project';

// Layout previews read the selected spread's content, document parameters, pagination and book anchors.
// Render-session URLs, document metadata and content on other spreads do not affect their artwork.
export function layoutPreviewKey(summary: ProjectSummary, template: TemplateInfo, spread: SpreadState) {
  const photos = [...new Set(Object.values(spread.boxes).flatMap((box) => box.photo ? [box.photo] : []))].sort();
  const texts = [...new Set(Object.values(spread.boxes).flatMap((box) => box.text ? [box.text] : []))].sort();
  return JSON.stringify([
    summary.folder, summary.templateHash ?? summary.id, summary.network ?? [], template.format,
    spread, summary.project.params,
    summary.project.spreads.map((item) => {
      const layout = template.spreads[item.definition];
      // Anchors may depend on any of their layout's parameters. Their functions stay in the render frame.
      return [item.id, layout?.span, layout?.declaresAnchors ? [item.definition, item.params] : null];
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

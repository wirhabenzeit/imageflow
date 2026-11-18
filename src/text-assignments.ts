import type { RenderProject } from './project';
import type { Template, FlowPosition } from './template';
import { shownLayoutStates } from './layouts';
import { sourceFileName } from './source-locations';
import { onPage } from './page-scope';
import { splitFrontmatter } from './frontmatter';

type Target = { spread: string; page?: import('./project').PageSide; box: string; source: string };
export function textAssignments(book: RenderProject, template: Template) {
  const chains = new Map<string, Target[]>();
  const positions: Record<string, FlowPosition> = {};
  for (const sheet of book.project.spreads) for (const { page, state: spread } of shownLayoutStates(sheet)) {
    const definition = template.spreads[spread.definition];
    if (!definition) continue;
    const boxes = Object.entries(definition.boxes).filter(([, box]) => box.type === 'markdown')
      .sort(([, a], [, b]) => (a.flowOrder ?? 1) - (b.flowOrder ?? 1));
    for (const [box] of boxes) {
      const source = spread.boxes[box]?.text;
      if (!source) continue;
      if (!chains.has(source)) chains.set(source, []);
      chains.get(source)!.push({ spread: spread.id, ...onPage(page), box, source });
    }
  }
  for (const [source, chain] of chains) {
    const title = book.project.texts[source] ? sourceFileName(book.project.texts[source]) : undefined;
    // The header is read from the saved source, before any spread renders: it never depends on where the flow
    // breaks, so a layout may size its boxes from it without feeding back into the flow.
    const text = book.texts[source];
    const meta = (text === undefined ? null : splitFrontmatter(text).meta) ?? {};
    chain.forEach(({ spread, page, box }, index) => {
      positions[spread + ':' + (page ? page + ':' : '') + box] = { part: index + 1, parts: chain.length, title, meta };
    });
  }
  return { chains, positions };
}


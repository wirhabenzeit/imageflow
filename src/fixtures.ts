import { z } from 'zod';
import type { SpreadDefinition, TemplateInfo } from './desktop';
import type { Parameter, Parameters } from './parameters';
import { identifier } from './project';
import type { Project, SpreadState, Values } from './project';
import { spanFits } from './format';

// Authoring fixtures render layouts with synthetic content in a separate book, so an agent can test layouts that the
// saved book does not use yet, and see how they cope with long, empty or awkward content. Nothing is saved.

export const fixtureCases = ['typical', 'long-text', 'empty', 'portrait-photos', 'malformed-files'] as const;
export type FixtureCase = typeof fixtureCases[number];
export const fixtureCaseLabels: Record<FixtureCase, string> = {
  typical: 'Typical', 'long-text': 'Long text', empty: 'Empty', 'portrait-photos': 'Portrait photos', 'malformed-files': 'Malformed files',
};

export const fixtureLimits = {
  layouts: 24, formats: 4, cellsPerFormat: 48, previewCells: 12, diagnostics: 100,
  // Extra renders per check spent finding which fixtures make a fixture book fail.
  isolationRenders: 12,
} as const;

const id = identifier.refine((value) => value.length <= 128, 'Identifiers must be at most 128 characters.');
const fixtureCase = z.enum(fixtureCases);
export const fixtureRequestSchema = z.strictObject({
  layouts: z.array(id).min(1).max(fixtureLimits.layouts).optional()
    .describe('Layout IDs to test, including layouts the book does not use yet. Defaults to every declared layout (at most 24).'),
  formats: z.union([z.literal('all'), z.array(id).min(1).max(fixtureLimits.formats)]).optional()
    .describe('Print format IDs to test, or "all" for up to four declared formats. Defaults to the book\'s current format.'),
  cases: z.array(fixtureCase).min(1).max(fixtureCases.length).optional()
    .describe('Synthetic content cases. Defaults to every case that applies to each layout.'),
  preview: z.strictObject({
    printFormat: id.optional().describe('Format whose fixtures appear in the image. Defaults to the first tested format.'),
    cells: z.array(z.strictObject({ layout: id, case: fixtureCase })).min(1).max(fixtureLimits.previewCells).optional()
      .describe('Fixtures to show, in order. Defaults to the first 12 tested fixtures of that format.'),
    columns: z.int().min(1).max(4).default(3),
    bounds: z.enum(['trim', 'bleed']).default('trim'),
    maxEdge: z.int().min(128).max(1600).default(1200),
    format: z.enum(['png', 'jpeg']).default('png'),
    guides: z.boolean().default(false), labels: z.boolean().default(false),
  }).optional().describe('Return a labelled contact sheet of synthetic fixtures. It never shows the saved book.'),
});
export type FixtureRequest = z.output<typeof fixtureRequestSchema>;

export class FixtureError extends Error {
  constructor(readonly code: 'LAYOUT_NOT_FOUND' | 'FORMAT_NOT_FOUND' | 'FIXTURE_NOT_FOUND', message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

export type FixtureCell = { layout: string; case: FixtureCase; spread: string; label: string };
export type FixtureSkip = { layout?: string; case?: FixtureCase; format?: string; reason: string };
export type FixturePlan = {
  layouts: string[]; formats: string[]; cases: FixtureCase[];
  // Every format tests the same cells.
  cells: FixtureCell[];
  skipped: FixtureSkip[];
  preview?: Omit<NonNullable<FixtureRequest['preview']>, 'printFormat' | 'cells'> & { printFormat: string; cells: FixtureCell[] };
};

type Inputs = { photos: number; markdown: number; strings: number; files: number };
function layoutInputs(definition: SpreadDefinition): Inputs {
  const parameters: Parameter[] = [definition.parameters, ...Object.values(definition.boxes).map((box) => box.parameters),
    ...Object.values(definition.elements).map((element) => element.parameters)].flatMap((group) => Object.values(group));
  const boxes = Object.values(definition.boxes);
  return {
    photos: boxes.filter(({ type }) => type === 'photo').length, markdown: boxes.filter(({ type }) => type === 'markdown').length,
    strings: parameters.filter(({ type }) => type === 'string').length, files: parameters.filter(({ type }) => type === 'file').length,
  };
}

/** Why a case says nothing new about a layout, or undefined when it applies. */
function inapplicable(fixture: FixtureCase, inputs: Inputs) {
  switch (fixture) {
    case 'typical': return undefined;
    case 'long-text': return inputs.strings || inputs.markdown ? undefined : 'The layout has no string parameters or Markdown boxes.';
    case 'empty': return inputs.photos + inputs.markdown + inputs.strings + inputs.files ? undefined : 'The layout has no boxes, string or file parameters.';
    case 'portrait-photos': return inputs.photos ? undefined : 'The layout has no photo boxes.';
    case 'malformed-files': return inputs.files ? undefined : 'The layout has no file parameters.';
  }
}

// Whether a layout fits a format of the template: page layouts need a format without facing pages, the others one
// with them. Fixtures render each layout only in the formats it fits.
export function fixtureFits(template: TemplateInfo, layout: string, format: string) {
  const structure = template.structures?.[format] ?? (format === template.formatId ? template.format.structure : undefined);
  return structure ? spanFits(template.spreads[layout].span, { structure }) : template.spreads[layout].span !== 'page';
}

export function availableFormats(template: TemplateInfo) {
  const declared = Object.keys(template.formats);
  return declared.length ? declared : [template.formatId];
}

export function fixtureSpreadId(layout: string, fixture: FixtureCase) {
  return 'fixture-' + fixture + '-' + layout;
}

export function planFixtures(template: TemplateInfo, request: FixtureRequest): FixturePlan {
  const skipped: FixtureSkip[] = [];
  const declaredLayouts = Object.keys(template.spreads);
  for (const layout of request.layouts ?? []) {
    if (!template.spreads[layout]) throw new FixtureError('LAYOUT_NOT_FOUND', 'The template declares no layout ' + layout + '. Declared layouts: ' + declaredLayouts.join(', ') + '.');
  }
  let layouts = [...new Set(request.layouts ?? declaredLayouts)];
  if (layouts.length > fixtureLimits.layouts) {
    skipped.push(...layouts.slice(fixtureLimits.layouts).map((layout) => ({ layout, reason: 'Only ' + fixtureLimits.layouts + ' layouts are tested per check; request the remaining layouts explicitly.' })));
    layouts = layouts.slice(0, fixtureLimits.layouts);
  }
  const declaredFormats = availableFormats(template);
  let formats: string[];
  if (request.formats === 'all') {
    formats = declaredFormats.slice(0, fixtureLimits.formats);
    skipped.push(...declaredFormats.slice(fixtureLimits.formats).map((format) => ({ format, reason: 'Only ' + fixtureLimits.formats + ' formats are tested per check; request the remaining formats explicitly.' })));
  } else {
    for (const format of request.formats ?? []) {
      if (!declaredFormats.includes(format)) throw new FixtureError('FORMAT_NOT_FOUND', 'The template declares no format ' + format + '. Declared formats: ' + declaredFormats.join(', ') + '.');
    }
    formats = [...new Set(request.formats ?? [template.formatId])];
  }
  const untested = declaredFormats.filter((format) => !formats.includes(format) && !skipped.some((skip) => skip.format === format));
  if (untested.length) skipped.push(...untested.map((format) => ({ format, reason: 'Not requested. Pass formats: "all" to test every format.' })));
  // A layout no tested format fits is not rendered; one that fits only some of them is left out of the others.
  const unfit = layouts.filter((layout) => !formats.some((format) => fixtureFits(template, layout, format)));
  for (const layout of unfit) {
    skipped.push({ layout, reason: template.spreads[layout].span === 'page'
      ? "A single-page layout (span: 'page') needs a format without facing pages, and no tested format is one."
      : 'A layout for facing pages needs a format with facing pages, and no tested format has them.' });
  }
  layouts = layouts.filter((layout) => !unfit.includes(layout));
  for (const layout of layouts) {
    for (const format of formats) {
      if (!fixtureFits(template, layout, format)) skipped.push({ layout, format, reason: 'The layout does not fit this format: ' +
        (template.spreads[layout].span === 'page' ? 'it is a single page, and the format has facing pages.' : 'it is for facing pages, and the format has none.') });
    }
  }
  const cases = request.cases ? [...new Set(request.cases)] : [...fixtureCases];
  const cells: FixtureCell[] = [];
  for (const layout of layouts) {
    const definition = template.spreads[layout];
    const inputs = layoutInputs(definition);
    for (const fixture of cases) {
      const reason = inapplicable(fixture, inputs);
      if (reason) { skipped.push({ layout, case: fixture, reason }); continue; }
      if (cells.length >= fixtureLimits.cellsPerFormat) {
        skipped.push({ layout, case: fixture, reason: 'Only ' + fixtureLimits.cellsPerFormat + ' fixtures are rendered per format; request fewer layouts or cases.' });
        continue;
      }
      cells.push({ layout, case: fixture, spread: fixtureSpreadId(layout, fixture), label: definition.label + ' · ' + fixtureCaseLabels[fixture] });
    }
  }
  const plan: FixturePlan = { layouts, formats, cases, cells, skipped };
  if (request.preview) {
    const { printFormat = formats[0], cells: requested, ...options } = request.preview;
    if (!formats.includes(printFormat)) throw new FixtureError('FIXTURE_NOT_FOUND', 'Preview format ' + printFormat + ' is not among the tested formats: ' + formats.join(', ') + '.');
    const shown = requested ? requested.map(({ layout, case: fixture }) => {
      const cell = cells.find((candidate) => candidate.layout === layout && candidate.case === fixture);
      if (!cell) throw new FixtureError('FIXTURE_NOT_FOUND', 'Fixture ' + layout + '/' + fixture + ' is not tested by this check. Check the skipped list or request that layout and case.');
      return cell;
    }) : cells.filter((cell) => fixtureFits(template, cell.layout, printFormat)).slice(0, fixtureLimits.previewCells);
    if (shown.length) plan.preview = { ...options, printFormat, cells: shown };
  }
  return plan;
}

// Deterministic synthetic copy. Each sentence is plain English so text measurement resembles real prose.
const sentences = [
  'The road follows the shoreline for a while before it climbs into the hills above the fjord.',
  'We stopped at a small harbour where the boats were tied up for the evening and the water was perfectly still.',
  'In the morning the light came in low across the bay, catching the tops of the mountains first.',
  'Nobody else was on the trail, so we took our time and stopped often to look back at the view.',
  'A narrow bridge crossed the river just below the waterfall, and the spray reached us even from the road.',
  'By the afternoon the clouds had cleared, and the beach was warm enough to sit on for an hour.',
  'Supper was fish soup and bread in a kitchen that smelled of woodsmoke and coffee.',
  'We wrote down the names of the places we passed so that we would remember them later.',
];
function prose(words: number, offset = 0) {
  const paragraphs: string[] = [];
  let count = 0, index = offset;
  while (count < words) {
    const paragraph: string[] = [];
    for (let n = 0; n < 4 && count < words; n++, index++) {
      const sentence = sentences[index % sentences.length];
      paragraph.push(sentence);
      count += sentence.split(' ').length;
    }
    paragraphs.push(paragraph.join(' '));
  }
  return paragraphs;
}

export const fixtureMarkdown = {
  typical: ['## A day on the coast', '', ...prose(180).flatMap((paragraph) => [paragraph, ''])].join('\n'),
  long: [
    '# An unusually long section heading that wraps across several lines in a narrow column',
    '', ...prose(700).flatMap((paragraph) => [paragraph, '']),
    '## Notes, lists and a very long unbreakable reference', '',
    '- A first item with a short note', '- A second item that continues long enough to wrap onto a following line in most column widths',
    '- https://example.org/a/very/long/path/that/contains/no/natural/break/points/at/all', '',
    '> A quotation that runs for more than one line, so its indentation and spacing are visible in the layout.', '',
    ...prose(1500, 3).flatMap((paragraph) => [paragraph, '']),
  ].join('\n'),
};

const longLine = 'An unusually long title that keeps going so the layout has to wrap, shrink or clip it somewhere';
function longString(maxLength: number | undefined, multiline: boolean | undefined) {
  const target = Math.min(maxLength ?? 240, 400);
  const lines = multiline ? [longLine, 'A second line that is also fairly long', 'And a third line'] : [longLine];
  let text = lines.join(multiline ? '\n' : ' ');
  while (text.length < target) text += (multiline ? '\n' : ' ') + longLine;
  return text.slice(0, target).trimEnd();
}

export type FixtureSourceIds = {
  photo: { landscape: string; portrait: string };
  // Malformed file sources by lowercase extension, such as `.gpx`.
  file: (extension: string) => string;
};

function sampleValues(parameters: Parameters, fixture: FixtureCase, ids: FixtureSourceIds): Values {
  const values: Values = {};
  for (const [key, param] of Object.entries(parameters)) {
    if (param.type === 'string') {
      if (fixture === 'long-text') values[key] = longString(param.maxLength, param.multiline);
      else if (fixture === 'empty') values[key] = '';
      else {
        const sample = param.default || param.placeholder || '';
        values[key] = param.maxLength === undefined ? sample : sample.slice(0, param.maxLength);
      }
    } else if (param.type === 'file' && fixture === 'malformed-files') {
      values[key] = ids.file(param.accept[0]);
    }
  }
  return values;
}

/** One spread of a layout with the content of a fixture case. `text` is this spread's own Markdown source, so
 * synthetic text never continues on another spread. */
export function fixtureSpread(cell: FixtureCell, definition: SpreadDefinition, ids: FixtureSourceIds, text: string): SpreadState {
  const photo = cell.case === 'portrait-photos' ? ids.photo.portrait : ids.photo.landscape;
  const filled = cell.case !== 'empty';
  return {
    id: cell.spread, definition: cell.layout,
    params: sampleValues(definition.parameters, cell.case, ids),
    boxes: Object.fromEntries(Object.entries(definition.boxes).map(([box, declared]) => [box, {
      params: sampleValues(declared.parameters, cell.case, ids),
      ...(filled ? declared.type === 'photo' ? { photo } : { text } : {}),
    }])),
    elements: Object.fromEntries(Object.entries(definition.elements).map(([element, declared]) => [element, {
      params: sampleValues(declared.parameters, cell.case, ids),
    }])),
  };
}

export function fixtureTextId(cell: FixtureCell) {
  return 'fixture-text-' + cell.case + '-' + cell.layout;
}

/** The saved project with its spreads replaced by fixture spreads in one format. Document parameters stay as saved,
 * so book-wide styling matches the user's book. */
export function fixtureProject(project: Project, template: TemplateInfo, format: string, cells: FixtureCell[], ids: FixtureSourceIds) {
  const texts: Record<string, string> = {};
  const markdown: Record<string, string> = {};
  const spreads = cells.map((cell) => {
    const text = fixtureTextId(cell);
    if (cell.case !== 'empty' && Object.values(template.spreads[cell.layout].boxes).some(({ type }) => type === 'markdown')) {
      texts[text] = 'synthetic/' + cell.case + '.md';
      markdown[text] = cell.case === 'long-text' ? fixtureMarkdown.long : fixtureMarkdown.typical;
    }
    return fixtureSpread(cell, template.spreads[cell.layout], ids, text);
  });
  return {
    project: {
      ...project, ...(Object.keys(template.formats).length ? { format } : {}),
      texts: { ...project.texts, ...texts }, spreads,
    } satisfies Project,
    markdown,
  };
}

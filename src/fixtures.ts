import { z } from 'zod';
import type { SpreadDefinition, TemplateInfo } from './desktop';
import type { Parameter, Parameters } from './parameters';
import { bookFormatOf, identifier, pageSides } from './project';
import type { Project, SpreadState, Values } from './project';
import { spanFits } from './format';

// Authoring fixtures render layouts with synthetic content in a separate book, so an agent can test layouts that the
// saved book does not use yet, and see how they cope with long, empty or awkward content. Nothing is saved.

export const fixtureCases = ['typical', 'long-text', 'empty', 'portrait-photos', 'malformed-files', 'alternate-files'] as const;
export type FixtureCase = typeof fixtureCases[number];
export const fixtureCaseLabels: Record<FixtureCase, string> = {
  typical: 'Typical', 'long-text': 'Long text', empty: 'Empty', 'portrait-photos': 'Portrait photos', 'malformed-files': 'Malformed files',
  'alternate-files': 'Alternate files',
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
    .describe('Print format IDs to test (at most four per check), or "all" for the first four declared formats. Defaults to the book\'s current format.'),
  cases: z.array(fixtureCase).min(1).max(fixtureCases.length).optional()
    .describe('Synthetic content cases. Defaults to every case that applies to each layout.'),
  cover: z.strictObject({
    layout: id.describe('Cover layout ID.'),
    pages: z.int().min(0).describe('Interior page count to size the cover against.'),
    format: id.optional().describe('Cover-enabled format ID. Defaults to the active format.'),
  }).optional().describe('Check a cover layout with synthetic content.'),
  preview: z.strictObject({
    printFormat: id.optional().describe('Format whose fixtures appear in the image. Defaults to the first tested format.'),
    cells: z.array(z.strictObject({ layout: id.describe('Layout ID.'), case: fixtureCase.describe('Fixture case.') })).min(1).max(fixtureLimits.previewCells).optional()
      .describe('Fixtures to show, in order. Defaults to the first 12 tested fixtures of that format.'),
    columns: z.int().min(1).max(4).default(3).describe('Fixtures per row.'),
    bounds: z.enum(['trim', 'bleed']).default('trim').describe('Crop to the trimmed page, or include the bleed.'),
    maxEdge: z.int().min(128).max(1600).default(1200).describe('Longest image edge in pixels.'),
    format: z.enum(['png', 'jpeg']).default('png').describe('Image encoding.'),
    guides: z.boolean().default(false).describe('Draw trim and safe-area guides.'),
    labels: z.boolean().default(false).describe('Outline and label every box and element.'),
  }).optional().describe('Return a labelled contact sheet of synthetic fixtures. It never shows the saved book.'),
}).refine(({ cover, layouts, formats, preview }) => !cover || !(layouts || formats || preview),
  'A cover fixture uses cover and cases. Interior layouts, formats and contact sheet previews are separate requests.');
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

type Inputs = { photos: number; markdown: number; strings: number; files: number; sampleFiles: number };
function layoutInputs(definition: Pick<SpreadDefinition, 'parameters' | 'boxes' | 'elements'>): Inputs {
  // A list's item fields count like parameters: fixtures fill one item of each list.
  const parameters: Parameter[] = [definition.parameters, ...Object.values(definition.boxes).map((box) => box.parameters),
    ...Object.values(definition.elements).map((element) => element.parameters)].flatMap((group) => Object.values(group))
    .flatMap((param) => param.type === 'list' ? Object.values(param.item) : [param]);
  const boxes = Object.values(definition.boxes);
  return {
    photos: boxes.filter(({ type }) => type === 'photo').length, markdown: boxes.filter(({ type }) => type === 'markdown').length,
    strings: parameters.filter(({ type }) => type === 'string').length, files: parameters.filter(({ type }) => type === 'file').length,
    sampleFiles: parameters.filter((param) => param.type === 'file' && sampleExtension(param.accept)).length,
  };
}

export function coverFixturePlan(template: TemplateInfo, request: NonNullable<FixtureRequest['cover']>, cases: FixtureCase[]) {
  const format = request.format ?? template.formatId;
  const layout = template.coverLayouts && Object.hasOwn(template.coverLayouts, request.layout) ? template.coverLayouts[request.layout] : undefined;
  if (!template.coverFormats || !Object.hasOwn(template.coverFormats, format)) {
    throw new FixtureError('FORMAT_NOT_FOUND', 'Format ' + format + ' has no exterior cover.');
  }
  if (!layout || (layout.formats && !layout.formats.includes(format))) {
    throw new FixtureError('LAYOUT_NOT_FOUND', 'Cover layout ' + request.layout + ' is unavailable for ' + format + '.');
  }
  const inputs = layoutInputs(layout);
  const cells: FixtureCell[] = [], skipped: FixtureSkip[] = [];
  for (const item of new Set(cases)) {
    const reason = inapplicable(item, inputs);
    if (reason) skipped.push({ layout: request.layout, format, case: item, reason });
    else cells.push({ layout: request.layout, case: item, spread: 'fixture-cover-' + item, label: layout.label + ' · ' + fixtureCaseLabels[item] });
  }
  return { format, cells, skipped };
}

/** Why a case says nothing new about a layout, or undefined when it applies. */
function inapplicable(fixture: FixtureCase, inputs: Inputs) {
  switch (fixture) {
    case 'typical': return undefined;
    case 'long-text': return inputs.strings || inputs.markdown ? undefined : 'The layout has no string parameters or Markdown boxes.';
    case 'empty': return inputs.photos + inputs.markdown + inputs.strings + inputs.files ? undefined : 'The layout has no boxes, string or file parameters.';
    case 'portrait-photos': return inputs.photos ? undefined : 'The layout has no photo boxes.';
    case 'malformed-files': return inputs.files ? undefined : 'The layout has no file parameters.';
    case 'alternate-files': return inputs.sampleFiles ? undefined
      : 'The layout has no file parameters accepting a type with synthetic samples (' + Object.keys(fixtureFiles).join(', ') + ').';
  }
}

// Fixtures render each layout only in formats it fits; page layouts also work on either half of facing pages.
function fixtureStructure(template: TemplateInfo, format: string) {
  return template.structures?.[format] ?? template.printFormats?.[format]?.structure ?? template.format.structure;
}

export function fixtureFits(template: TemplateInfo, layout: string, format: string) {
  const structure = fixtureStructure(template, format);
  return spanFits(template.spreads[layout].span, { structure });
}

export function availableFormats(template: TemplateInfo) {
  const declared = Object.keys(template.formats);
  return declared.length ? declared : [template.formatId];
}

export function fixtureSpreadId(layout: string, fixture: FixtureCase) {
  return 'fixture-' + fixture + '-' + layout;
}

// Advice naming untested formats in batches that fit one check each.
function remainingFormats(formats: string[]) {
  const batches = Array.from({ length: Math.ceil(formats.length / fixtureLimits.formats) },
    (_, index) => formats.slice(index * fixtureLimits.formats, (index + 1) * fixtureLimits.formats));
  return 'test the remaining formats with ' + batches.map((batch) => 'formats: ' + JSON.stringify(batch)).join(', then ') + '.';
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
    const rest = declaredFormats.slice(fixtureLimits.formats);
    const reason = '"all" tests the first ' + fixtureLimits.formats + ' formats per check; ' + remainingFormats(rest);
    skipped.push(...rest.map((format) => ({ format, reason })));
  } else {
    for (const format of request.formats ?? []) {
      if (!declaredFormats.includes(format)) throw new FixtureError('FORMAT_NOT_FOUND', 'The template declares no format ' + format + '. Declared formats: ' + declaredFormats.join(', ') + '.');
    }
    formats = [...new Set(request.formats ?? [template.formatId])];
  }
  const untested = declaredFormats.filter((format) => !formats.includes(format) && !skipped.some((skip) => skip.format === format));
  if (untested.length) {
    // "all" covers every format only while the template declares no more than one check may test.
    const advice = declaredFormats.length <= fixtureLimits.formats ? 'Not requested. Pass formats: "all" to test every format.'
      : 'Not requested. One check tests at most ' + fixtureLimits.formats + ' formats; ' + remainingFormats(untested);
    skipped.push(...untested.map((format) => ({ format, reason: advice })));
  }
  // A layout no tested format fits is not rendered; one that fits only some of them is left out of the others.
  const unfit = layouts.filter((layout) => !formats.some((format) => fixtureFits(template, layout, format)));
  for (const layout of unfit) {
    skipped.push({ layout, reason: template.spreads[layout].span === 'page'
      ? "No tested format accepts this page layout."
      : 'A layout for facing pages needs a format with facing pages, and no tested format has them.' });
  }
  layouts = layouts.filter((layout) => !unfit.includes(layout));
  for (const layout of layouts) {
    for (const format of formats) {
      if (!fixtureFits(template, layout, format)) skipped.push({ layout, format, reason: 'The layout does not fit this format: ' +
        (template.spreads[layout].span === 'left' || template.spreads[layout].span === 'right'
          ? 'the format has no single end pages.' : 'it is for facing pages, and the format has none.') });
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

// Valid synthetic file contents by lowercase extension. `typical` is a realistic file (a GPX track with elevation and
// times); `alternate` a valid file in another common shape (a GPX track in several segments, without elevation or
// times), so layouts are tested against both. Deterministic, and placed in an invented, recognisably round area.
function gpxTrack(segments: number[][][], elevation: boolean) {
  const point = ([lat, lon, ele]: number[], index: number) => '<trkpt lat="' + lat.toFixed(6) + '" lon="' + lon.toFixed(6) + '">' +
    (elevation ? '<ele>' + ele.toFixed(1) + '</ele><time>' + new Date(Date.UTC(2024, 6, 1, 8) + index * 60_000).toISOString() + '</time>' : '') + '</trkpt>';
  let index = 0;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ImageFlow synthetic fixture" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '<metadata><name>Synthetic fixture track</name></metadata>\n<trk><name>Synthetic fixture track</name>\n' +
    segments.map((segment) => '<trkseg>\n' + segment.map((p) => point(p, index++)).join('\n') + '\n</trkseg>').join('\n') + '\n</trk>\n</gpx>\n';
}
function syntheticRoute(count: number) {
  // A loop of about 25 km climbing from 1,200 m to 2,100 m and back.
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return [46.5 + 0.06 * Math.sin(t * Math.PI * 2) + 0.01 * Math.sin(t * Math.PI * 12),
      8 + 0.09 * (1 - Math.cos(t * Math.PI * 2)) / 2 + 0.03 * t, 1200 + 900 * Math.sin(t * Math.PI) ** 2 + 40 * Math.sin(t * Math.PI * 9)];
  });
}
export const fixtureFiles: Record<string, { typical: string; alternate: string }> = {
  '.gpx': (() => {
    const route = syntheticRoute(181);
    return { typical: gpxTrack([route], true), alternate: gpxTrack([route.slice(0, 60), route.slice(75, 130), route.slice(140)], false) };
  })(),
};
/** The first accepted extension with synthetic sample files, if any. */
export function sampleExtension(accept: readonly string[]) {
  return accept.map((extension) => extension.toLowerCase()).find((extension) => Object.hasOwn(fixtureFiles, extension));
}

export type FixtureSourceIds = {
  photo: { landscape: string; portrait: string };
  // Malformed file sources by lowercase extension, such as `.gpx`.
  file: (extension: string) => string;
  // Valid synthetic file sources by lowercase extension (one of `fixtureFiles`) and variant.
  sample?: (extension: string, variant: 'typical' | 'alternate') => string;
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
    } else if (param.type === 'file' && fixture !== 'empty' && ids.sample) {
      // Every other filled case gets a valid synthetic file when the parameter accepts a type with samples.
      const extension = sampleExtension(param.accept);
      if (extension) values[key] = ids.sample(extension, fixture === 'alternate-files' ? 'alternate' : 'typical');
    } else if (param.type === 'list') {
      // Empty lists are empty (or as short as `min` allows); other cases fill items with the case's values, so a long
      // label or a malformed file inside a list item is tested too.
      const count = fixture === 'empty' ? param.min ?? 0 : Math.max(1, param.min ?? 0);
      values[key] = Array.from({ length: count }, (_, index) => ({ id: 'fixture' + (index + 1), ...sampleValues(param.item, fixture, ids) as Record<string, string | number | boolean> }));
    }
  }
  return values;
}

/** One spread of a layout with the content of a fixture case. `text` is this spread's own Markdown source, so
 * synthetic text never continues on another spread. */
export function fixtureSpread(cell: FixtureCell, definition: Pick<SpreadDefinition, 'parameters' | 'boxes' | 'elements'>, ids: FixtureSourceIds, text: string): SpreadState {
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
  const spreads = cells.map((cell): SpreadState => {
    const definition = template.spreads[cell.layout];
    const create = (side?: typeof pageSides[number]) => {
      const text = fixtureTextId(cell) + (side ? '-' + side : '');
      if (cell.case !== 'empty' && Object.values(definition.boxes).some(({ type }) => type === 'markdown')) {
        texts[text] = 'synthetic/' + cell.case + (side ? '-' + side : '') + '.md';
        markdown[text] = cell.case === 'long-text' ? fixtureMarkdown.long : fixtureMarkdown.typical;
      }
      return fixtureSpread(cell, definition, ids, text);
    };
    if (definition.span !== 'page' || fixtureStructure(template, format).facingPages === false) return create();
    // Both allowed sides render independently on one sheet. Distinct sources keep synthetic text from flowing
    // from the left fixture into the right fixture. A restricted layout leaves the other page blank.
    const pages = Object.fromEntries(pageSides.filter((side) => !definition.sides || definition.sides.includes(side)).map((side) => {
      const { id: _id, ...state } = create(side);
      return [side, state];
    }));
    return { id: cell.spread, definition: cell.layout, params: {}, boxes: {}, elements: {}, split: true as const, pages };
  });
  return {
    project: {
      ...project, cover: undefined, schemaVersion: bookFormatOf({ spreads }), ...(Object.keys(template.formats).length ? { format } : {}),
      texts: { ...project.texts, ...texts }, spreads,
    } satisfies Project,
    markdown,
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TemplateInfo } from '../src/desktop';
import { declarationWarnings } from '../src/declaration-check';
import type { Schema } from '../src/declaration-check';
import { fixtureFits, planFixtures, fixtureRequestSchema } from '../src/fixtures';
import { formatSchema, mm, pageLabel, pageSequence, pagesText, printFormat, resolveFormat, sheetPages, spanAllowedAt, trimBox } from '../src/format';
import type { FacingFormat, ResolvedFormat, SinglePageFormat } from '../src/format';
import { boundGeometry, design, lenientFormat, page, spread } from '../src/geometry';
import { layoutChoices } from '../src/layouts';
import { projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';
import { applyProjectCommands, ProjectCommandError } from '../src/project-commands';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';

const calendar = printFormat({
  label: 'Wall calendar · A4 portrait', trim: { width: mm(210), height: mm(297) }, facingPages: false,
  bleed: { all: mm(3), left: mm(5) }, safe: { top: mm(8), bottom: mm(10), left: mm(8), right: mm(12) },
  pageCount: { min: 13, max: 13, step: 1 },
});
const book = printFormat({
  label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: { all: mm(3), binding: mm(0) }, safe: mm(12),
  pageCount: { min: 2, max: 100, step: 2 },
});
const withCount = (pageCount: SinglePageFormat['structure']['pageCount']): SinglePageFormat => ({ ...calendar, structure: { facingPages: false, pageCount } });
const errors = (input: unknown) => {
  const parsed = formatSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(({ path, message }) => [path.join('.'), message]);
};
// Within the 0.12 mm tolerance of decision 0001.
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 0.12, actual + ' ≉ ' + expected);

test('printFormat builds a format without facing pages, with left and right insets and no delivery or ends', () => {
  assert.deepEqual(calendar.structure, { facingPages: false, pageCount: { min: 13, max: 13, step: 1 } });
  assert.deepEqual(calendar.bleed, { top: mm(3), bottom: mm(3), left: mm(5), right: mm(3) });
  assert.deepEqual(formatSchema.parse(calendar), calendar);
  // The default stays a format with facing pages.
  assert.equal(book.structure.facingPages, undefined);
  assert.equal((formatSchema.parse(book) as FacingFormat).structure.ends, 'single-pages');
});

test('the format schema is chosen by facingPages and explains side names of the other kind', () => {
  const { bleed: _bleed, safe: _safe, ...rest } = calendar;
  const facingSides = { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) };
  assert.deepEqual(errors({ ...rest, bleed: facingSides, safe: calendar.safe }),
    [['bleed', 'Formats without facing pages use left and right instead of outside and binding.']]);
  const { bleed: _b, safe: _s, ...facing } = book;
  assert.deepEqual(errors({ ...facing, bleed: calendar.bleed, safe: book.safe }),
    [['bleed', 'Formats with facing pages use outside and binding instead of left and right. For one page per unit, set facingPages: false.']]);
  // Delivery and ends belong to facing pages.
  const [[path, message]] = errors({ ...calendar, structure: { ...calendar.structure, delivery: 'pages', ends: 'single-pages' } });
  assert.equal(path, 'structure');
  assert.match(message, /Formats without facing pages have no delivery or ends/);
  // A step of one page needs a format without facing pages.
  assert.deepEqual(errors({ ...book, structure: { ...book.structure, pageCount: { min: 2, max: 100, step: 1 } } }).map(([at]) => at), ['structure.pageCount.step']);
  assert.deepEqual(errors({ ...calendar, structure: { ...calendar.structure, pageCount: { min: 1, max: 9, step: 3 } } }).map(([at]) => at), ['structure.pageCount.step']);
  // Geometry is validated per page.
  assert.deepEqual(errors({ ...calendar, safe: { top: mm(8), bottom: mm(8), left: mm(110), right: mm(100) } }),
    [['', 'Template safe insets leave no space inside the trim.']]);
  assert.deepEqual(errors({ ...calendar, trim: { width: mm(1000), height: mm(297) } }), [['', 'PDF dimensions must be between 10 and 1000 mm on each edge.']]);
});

test('a resolved page is the trim plus its left and right bleed', () => {
  const resolved = resolveFormat(calendar);
  assert.equal(resolved.facingPages, false);
  assert.equal(resolved.pageWidth, 218);
  assert.equal(resolved.spreadWidth, 218);
  assert.equal(resolved.outputWidth, 218);
  assert.equal(resolved.height, 303);
  assert.deepEqual(sheetPages(resolved), [{ side: 'page', trimX: 5, safeLeft: 8, safeRight: 12, bleedX: 0, bleedWidth: 218 }]);
  const facing = resolveFormat(book);
  assert.equal(facing.facingPages, true);
  assert.deepEqual(sheetPages(facing).map(({ side, trimX, bleedX }) => [side, trimX, bleedX]), [['left', 3, 0], ['right', 203, 203]]);
});

test('without facing pages every unit is one page, numbered in project order', () => {
  const sequence = pageSequence(Array(13).fill('page'), calendar);
  assert.deepEqual(sequence.issues, []);
  assert.equal(sequence.count, 13);
  assert.deepEqual(sequence.spreads.slice(0, 2), [{ span: 'page', page: { number: 1 }, sides: ['page'] }, { span: 'page', page: { number: 2 }, sides: ['page'] }]);
  assert.equal(pageLabel(sequence.spreads[2].page), '3');
  assert.equal(pagesText(sequence.spreads[2].page), 'Page 3');
  assert.equal(pagesText({ left: 2, right: 3 }), 'Pages 2–3');
  // The page-count rule with a step of one page.
  const steps = withCount({ min: 3, max: 6, step: 1 });
  assert.deepEqual([2, 3, 4, 6, 7].map((n) => pageSequence(Array(n).fill('page'), steps).issues.length), [1, 0, 0, 0, 1]);
  assert.match(pageSequence(['page'], calendar).issues[0], /^Page count is 1\. .* requires 13–13 pages\.$/);
});

test('layouts of the other kind are drawn and reported as page-sequence problems', () => {
  const single = pageSequence(['page', 'spread', 'page'], withCount({ min: 1, max: 20, step: 1 }));
  assert.deepEqual(single.spreads.map(({ page }) => page.number), [1, 2, 3]);
  assert.deepEqual(single.issues, ['Page 2 uses a spread layout, but Wall calendar · A4 portrait has no facing pages. Switch it to a single-page layout.']);
  const facing = pageSequence(['spread', 'page'], { ...book, structure: { ...book.structure, ends: 'inside-covers' } });
  assert.deepEqual(facing.spreads[1], { span: 'page', page: { left: 3, right: 4 }, sides: ['left', 'right'] });
  assert.deepEqual(facing.issues, ['Spread 2 uses a single-page layout, but Square has facing pages. Switch it to a spread layout.']);
  assert.equal(spanAllowedAt('page', 0, 1, calendar), true);
  assert.equal(spanAllowedAt('spread', 0, 1, calendar), false);
  assert.equal(spanAllowedAt('page', 0, 1, book), false);
});

test('geometry helpers describe one page without facing pages', () => {
  const format = resolveFormat(calendar);
  assert.deepEqual(page(format), { x: 0, y: 0, width: 210, height: 297 });
  assert.deepEqual(page(format, 'safe'), { x: 8, y: 8, width: 190, height: 279 });
  assert.deepEqual(page(format, 'bleed'), { x: -5, y: -3, width: 218, height: 303 });
  assert.throws(() => page(format, 'left'), /no facing pages, so a page has no side\. Call page\(\) without one/);
  assert.throws(() => spread(format, 'safe'), /no facing pages, so there is no spread\. Use page\('safe'\)/);
  const bound = boundGeometry(format);
  assert.deepEqual(bound.page('safe'), page(format, 'safe'));
  assert.deepEqual(design(format, { width: 105, height: 297 }).page(10, 0, 50, 100), { x: 20, y: 0, width: 100, height: 100 });
  assert.throws(() => design(format, { width: 105, height: 297 }).right(0, 0, 1, 1), /no facing pages/);
  // Facing formats still need a side, and keep their spreads.
  const facing = resolveFormat(book);
  assert.deepEqual(page(facing, 'right', 'safe'), { x: 212, y: 12, width: 176, height: 176 });
  assert.throws(() => page(facing, 'safe'), /has facing pages\. Name the page: page\('left', 'safe'\)/);
  assert.throws(() => design(facing, { width: 200, height: 200 }).page(0, 0, 1, 1), /has facing pages/);
  // A layout drawn in a format it does not fit gets answers instead of errors, so the book still previews.
  const lenient = boundGeometry(format, { lenient: true });
  assert.deepEqual(lenient.page('right', 'safe'), page(format, 'safe'));
  assert.deepEqual(lenient.spread('bleed'), page(format, 'bleed'));
  assert.deepEqual(boundGeometry(facing, { lenient: true }).page('trim'), page(facing, 'right'));
  // The standalone helpers too, when called with the format such a layout receives as ctx.format.
  assert.deepEqual(spread(lenientFormat(format), 'bleed'), page(format, 'bleed'));
  assert.deepEqual(page(lenientFormat(facing), 'safe'), page(facing, 'right', 'safe'));
});

test('export trim boxes are inset by the bleed on each edge', () => {
  const single = resolveFormat(calendar);
  const box = trimBox(single, 'page');
  near(box.x, 5); near(box.y, 3); near(box.width, 210); near(box.height, 297);
  near(single.outputWidth - box.x - box.width, 3);
  const facing = resolveFormat(book);
  assert.deepEqual(trimBox(facing, 'left'), { x: 3, y: 3, width: 200, height: 200 });
  assert.deepEqual(trimBox(facing, 'right'), { x: 0, y: 3, width: 200, height: 200 });
  const spreads = resolveFormat({ ...book, structure: { ...book.structure, delivery: 'spreads' } } as FacingFormat);
  assert.deepEqual(trimBox(spreads, 'spread'), { x: 3, y: 3, width: 400, height: 200 });
});

const layout = (span?: 'spread' | 'page' | 'left' | 'right') => ({ label: span ?? 'Default', ...(span ? { span } : {}), render: () => null });
const declare = (extra: Record<string, unknown>) => ({ id: 'calendar', version: '1', contract: 1, requires: ['single-pages'], ...extra });

test('span defaults to page when no format has facing pages, and to spread otherwise', () => {
  const single = templateSchema.parse(declare({ format: calendar, spreads: { month: layout() } }));
  assert.equal(single.spreads.month.span, 'page');
  const mixed = templateSchema.parse(declare({ formats: { calendar, book }, spreads: { month: layout('page'), spread: layout() } }));
  assert.equal(mixed.spreads.spread.span, 'spread');
  assert.equal(mixed.spreads.month.span, 'page');
});

test('a layout no format fits is a declaration warning', () => {
  const warned = (declared: Record<string, unknown>) =>
    declarationWarnings(declared, templateSchema as unknown as Schema).filter(({ code }) => code === 'declaration-span-unused').map(({ path }) => path);
  assert.deepEqual(warned(declare({ format: calendar, spreads: { month: layout(), wide: layout('spread') } })), ['spreads.wide.span']);
  assert.deepEqual(warned(declare({ format: book, spreads: { month: layout('page'), body: layout() } })), ['spreads.month.span']);
  assert.deepEqual(warned(declare({ formats: { calendar, book }, spreads: { month: layout('page'), body: layout() } })), []);
});

test('opening spreads must fit the formats of the default format’s kind', () => {
  const opening = [{ layout: 'month', params: {} }];
  assert.ok(templateSchema.safeParse(declare({ format: calendar, spreads: { month: layout() }, openingSpreads: opening })).success);
  const wrong = templateSchema.safeParse(declare({ format: calendar, spreads: { month: layout(), wide: layout('spread') },
    openingSpreads: [{ layout: 'wide', params: {} }] }));
  assert.equal(wrong.success, false);
  assert.match(wrong.error!.issues[0].message, /Layout wide is for facing pages, but the format has none/);
  // A template of both kinds starts books in its default format.
  assert.ok(templateSchema.safeParse(declare({ formats: { calendar, book }, defaultFormat: 'calendar',
    spreads: { month: layout('page'), body: layout() }, openingSpreads: opening })).success);
});

const mixed = templateSchema.parse(declare({ formats: { calendar, book },
  spreads: { month: layout('page'), year: layout('page'), body: layout('spread'), other: layout('spread'), end: layout('left') } }));
const info = (format: string): TemplateInfo => templateInfo(chooseFormat(mixed, format));

test('layout choices follow the chosen format, and a mismatched layout may switch to one that fits', () => {
  const single = info('calendar').format, facing = info('book').format;
  assert.deepEqual(layoutChoices(mixed.spreads, 'month', single), ['month', 'year']);
  assert.deepEqual(layoutChoices(mixed.spreads, 'body', facing), ['body', 'other']);
  assert.deepEqual(layoutChoices(mixed.spreads, 'body', single), ['month', 'year', 'body']);
  assert.deepEqual(layoutChoices(mixed.spreads, 'month', facing), ['month', 'body', 'other']);
  assert.deepEqual(Object.fromEntries(Object.entries(info('calendar').structures!).map(([id, { facingPages }]) => [id, facingPages !== false])),
    { calendar: false, book: true });
});

test('fixtures render each layout only in the formats it fits', () => {
  const template = info('calendar');
  assert.equal(fixtureFits(template, 'month', 'calendar'), true);
  assert.equal(fixtureFits(template, 'month', 'book'), false);
  const plan = planFixtures(template, fixtureRequestSchema.parse({ layouts: ['month', 'body'], cases: ['typical'] }));
  assert.deepEqual(plan.layouts, ['month']);
  assert.match(plan.skipped.find(({ layout }) => layout === 'body')!.reason, /needs a format with facing pages/);
  const all = planFixtures(template, fixtureRequestSchema.parse({ layouts: ['month', 'body'], cases: ['typical'], formats: 'all' }));
  assert.deepEqual(all.layouts, ['month', 'body']);
  assert.deepEqual(all.skipped.filter(({ format }) => format).map(({ layout, format }) => [layout, format]), [['month', 'book'], ['body', 'calendar']]);
});

test('MCP commands insert and switch only layouts that fit the book’s format', () => {
  const files = (): ProjectFiles => ({
    project: projectSchema.parse({ schemaVersion: 1, title: 'Calendar', template: { id: 'calendar', version: '1' }, format: 'calendar',
      spreads: [{ id: 'jan', definition: 'month' }] }),
    photoIndex: {},
  });
  const template = info('calendar');
  const inserted = applyProjectCommands(files(), template, [{ op: 'insert_spread', definition: 'year', after: 'jan' }]);
  assert.deepEqual(inserted.files.project.spreads.map(({ definition }) => definition), ['month', 'year']);
  assert.throws(() => applyProjectCommands(files(), template, [{ op: 'insert_spread', definition: 'body' }]), (error) =>
    error instanceof ProjectCommandError && error.code === 'INCOMPATIBLE_LAYOUT' && /which has no facing pages\. Insert a single-page layout/.test(error.message));
  assert.throws(() => applyProjectCommands(files(), template, [{ op: 'switch_layout', spread: 'jan', definition: 'body' }]), (error) =>
    error instanceof ProjectCommandError && error.code === 'INCOMPATIBLE_LAYOUT' && /Choose a single-page layout/.test(error.message));
  // A format selected earlier in the batch applies to the commands after it.
  const switched = applyProjectCommands(files(), template, [{ op: 'select_format', format: 'book' }, { op: 'insert_spread', definition: 'other' }]);
  assert.deepEqual(switched.files.project.spreads.map(({ definition }) => definition), ['month', 'other']);
  // There, the first spread must become a single right page.
  assert.throws(() => applyProjectCommands(files(), template, [{ op: 'select_format', format: 'book' }, { op: 'switch_layout', spread: 'jan', definition: 'body' }]),
    (error) => error instanceof ProjectCommandError && /requires a layout with span: 'right' in Square/.test(error.message));
  assert.throws(() => applyProjectCommands(files(), template, [{ op: 'select_format', format: 'book' }, { op: 'insert_spread', definition: 'year' }]),
    (error) => error instanceof ProjectCommandError && /which has facing pages\. Insert a spread layout/.test(error.message));
});

test('a fixture preview in a format shows the layouts that fit it, however many others come first', () => {
  const spreads = Object.fromEntries([...Array.from({ length: 12 }, (_, i) => ['wide' + i, layout('spread')]), ['month', layout('page')]]);
  const declared = templateSchema.parse(declare({ formats: { book, calendar }, spreads }));
  const template = templateInfo(chooseFormat(declared, 'book'));
  const plan = planFixtures(template, fixtureRequestSchema.parse({ formats: 'all', cases: ['typical'], preview: { printFormat: 'calendar' } }));
  assert.deepEqual(plan.preview?.cells.map(({ layout }) => layout), ['month']);
});

// Keep the narrowed types in use, so a change to the union shows up here at compile time.
export const kinds: [SinglePageFormat['structure']['facingPages'], ResolvedFormat['facingPages']] = [false, true];

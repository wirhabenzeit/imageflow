import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationWarnings } from '../src/declaration-check';
import type { Schema } from '../src/declaration-check';
import { firstSpreadLayouts } from '../src/editing';
import { formatSchema, mm, pageSequence, printFormat, spanFits } from '../src/format';
import type { FacingFormat } from '../src/format';
import { layoutChoices } from '../src/layouts';
import { projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';
import { applyProjectCommands, ProjectCommandError } from '../src/project-commands';
import { insertionProblem, spreadOrder } from '../src/spread-order';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';

// #46: under ends: 'single-pages' the format requires the book to open on a single right page and close on a single
// left page, with full spreads between them.
const blurb = printFormat({ label: 'Blurb', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
  pageCount: { min: 2, max: 100, step: 2 } });
const saal = { ...blurb, label: 'Saal', structure: { ...blurb.structure, ends: 'inside-covers' as const } } satisfies FacingFormat;
const layout = (span?: 'spread' | 'left' | 'right') => ({ label: span ?? 'Body', ...(span ? { span } : {}), render: () => null });
const declared = templateSchema.parse({ id: 'ends', version: '1', contract: 1, formats: { blurb, saal },
  spreads: { title: layout('right'), body: layout(), other: layout(), closing: layout('left') } });
const template = templateInfo(chooseFormat(declared, 'blurb'));
const ids = (spreads: { id: string }[] | undefined) => spreads?.map(({ id }) => id);

test("delivery: 'spreads' cannot have single end pages, and printFormat defaults its ends to inside covers", () => {
  const parsed = formatSchema.safeParse({ ...blurb, structure: { ...blurb.structure, delivery: 'spreads' } });
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.error!.issues.map(({ path }) => path.join('.')), ['structure.ends']);
  assert.match(parsed.error!.issues[0].message, /cannot open on a single right page/);
  const spreads = printFormat({ label: 'Lay-flat', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
    pageCount: { min: 2, max: 100, step: 2 }, delivery: 'spreads' });
  assert.equal(spreads.structure.ends, 'inside-covers');
  assert.ok(formatSchema.safeParse(spreads).success);
});

test('the page sequence requires a single right page first and a single left page last', () => {
  assert.deepEqual(pageSequence(['right', 'spread', 'spread', 'left'], blurb).issues, []);
  assert.deepEqual(pageSequence(['spread', 'spread', 'right', 'left'], blurb).issues.slice(0, 1), [
    "Spread 1 is a full spread, but Blurb requires the book to open on a single right page. Switch it to a layout with span: 'right'."]);
  assert.deepEqual(pageSequence(['right', 'spread', 'left', 'spread'], blurb).issues.slice(1), [
    "Spread 4 is a full spread, but Blurb requires the book to close on a single left page. Switch it to a layout with span: 'left'."]);
  assert.deepEqual(pageSequence(['right', 'right', 'left'], blurb).issues.filter((issue) => !issue.startsWith('Page count')), [
    'Spread 2 is a single right page, but single pages belong only at the book ends. Switch it to a full spread layout.']);
  assert.match(pageSequence(['right'], blurb).issues[0], /only its opening page, but Blurb requires it to close on a single left page/);
  // Inside covers take full spreads throughout.
  assert.deepEqual(pageSequence(['spread', 'spread'], saal).issues, []);
  assert.match(pageSequence(['right', 'spread', 'spread'], saal).issues[0], /Saal has no single pages at the book ends/);
  assert.equal(spanFits('right', saal), false);
  assert.equal(spanFits('left', blurb), true);
});

const book = projectSchema.parse({ schemaVersion: 1, title: 'Ends', template: { id: 'ends', version: '1' },
  spreads: [['t', 'title'], ['a', 'body'], ['b', 'body'], ['c', 'closing']].map(([id, definition]) => ({ id, definition })) }).spreads;

test('spreads cannot move into or out of the book ends', () => {
  assert.deepEqual(ids(spreadOrder(book, 'a', 2, template)), ['t', 'b', 'a', 'c']);
  for (const [id, target] of [['a', 0], ['a', 3], ['t', 1], ['c', 2]] as const) assert.equal(spreadOrder(book, id, target, template), undefined, id + '→' + target);
  // A book that lost its opening page can get it back.
  const broken = [book[1], book[0], book[2], book[3]];
  assert.deepEqual(ids(spreadOrder(broken, 't', 0, template)), ['t', 'a', 'b', 'c']);
});

test('nothing is inserted before the opening page or after the closing page', () => {
  assert.equal(insertionProblem(book, 2, 'spread', template), undefined);
  assert.match(insertionProblem(book, 0, 'spread', template)!, /nothing can go before it/);
  assert.match(insertionProblem(book, 4, 'spread', template)!, /nothing can go after it/);
  assert.match(insertionProblem(book, 0, 'right', template)!, /can only open the book/);
  assert.match(insertionProblem(book, 2, 'left', template)!, /can only close the book/);
  // A book still missing its closing page may get one, or grow at its end.
  assert.equal(insertionProblem(book.slice(0, 3), 3, 'left', template), undefined);
  assert.equal(insertionProblem(book.slice(0, 3), 3, 'spread', template), undefined);
  assert.equal(insertionProblem([], 0, 'right', template), undefined);
  assert.match(insertionProblem([], 0, 'spread', template)!, /must open on a single right page/);
  assert.equal(insertionProblem(book, 0, 'spread', { ...template, format: saal }), undefined);
});

test('the first and last positions offer their end layouts', () => {
  const at = (current: string, index: number) => layoutChoices(template.spreads, current, blurb, { index, count: 4 });
  assert.deepEqual(at('title', 0), ['title']);
  assert.deepEqual(at('closing', 3), ['closing']);
  assert.deepEqual(at('body', 1), ['body', 'other']);
  // A full spread at the start may become the opening page, or switch to another full spread.
  assert.deepEqual(at('body', 0), ['title', 'body', 'other']);
  assert.deepEqual(firstSpreadLayouts(template.spreads, blurb), ['title']);
  // Under inside covers the end layouts do not fit, and a misplaced one may switch to a full spread.
  assert.deepEqual(layoutChoices(template.spreads, 'title', saal, { index: 0, count: 4 }), ['title', 'body', 'other']);
});

test('MCP commands keep the ends and report the position', () => {
  const files = (): ProjectFiles => ({ project: projectSchema.parse({ schemaVersion: 1, title: 'Ends', template: { id: 'ends', version: '1' }, spreads: book }), photoIndex: {} });
  const rejected = (operations: unknown[], pattern: RegExp) => assert.throws(() => applyProjectCommands(files(), template, operations),
    (error) => error instanceof ProjectCommandError && error.code === 'INVALID_POSITION' && pattern.test(error.message));
  rejected([{ op: 'insert_spread', definition: 'body', after: null }], /must open on a single right page/);
  rejected([{ op: 'insert_spread', definition: 'body' }], /must close on a single left page/);
  rejected([{ op: 'duplicate_spread', spread: 't' }], /single right page can only open the book/);
  rejected([{ op: 'move_spread', spread: 'a', after: null }], /cannot move into or out of those ends/);
  rejected([{ op: 'move_spread', spread: 'c', after: 'a' }], /cannot move into or out of those ends/);
  const ok = applyProjectCommands(files(), template, [{ op: 'insert_spread', definition: 'other', after: 'a' }, { op: 'move_spread', spread: 'b', after: 'a' },
    { op: 'duplicate_spread', spread: 'a' }]);
  assert.deepEqual(ok.files.project.spreads.map(({ definition }) => definition), ['title', 'body', 'body', 'body', 'other', 'closing']);
  // Removing an end spread stays possible; the page sequence reports it.
  assert.deepEqual(ids(applyProjectCommands(files(), template, [{ op: 'remove_spread', spread: 't' }]).files.project.spreads), ['a', 'b', 'c']);
});

test('declarations warn about missing end layouts and end layouts no format can use', () => {
  const warned = (spreads: Record<string, unknown>, format: unknown) =>
    declarationWarnings({ id: 'ends', version: '1', contract: 1, format, spreads }, templateSchema as unknown as Schema)
      .filter(({ code }) => code === 'declaration-ends-missing' || code === 'declaration-span-unused').map(({ code, path, details }) => [code, path, details.span]);
  assert.deepEqual(warned({ body: layout(), closing: layout('left') }, blurb), [['declaration-ends-missing', 'spreads', 'right']]);
  assert.deepEqual(warned({ title: layout('right'), body: layout() }, blurb), [['declaration-ends-missing', 'spreads', 'left']]);
  assert.deepEqual(warned({ title: layout('right'), body: layout(), closing: layout('left') }, blurb), []);
  assert.deepEqual(warned({ title: layout('right'), body: layout() }, saal), [['declaration-span-unused', 'spreads.title.span', 'right']]);
});

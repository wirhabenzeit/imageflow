import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstSpreadLayouts, openingSpreadStates } from '../src/editing';
import { mm, printFormat } from '../src/format';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import { chooseFormat, templateInfo, templateSchema } from '../src/template';

const render = () => null;
const pages = (ends: 'single-pages' | 'inside-covers') => printFormat({
  label: ends, trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10), pageCount: { min: 2, max: 40, step: 2 }, ends,
});
const spreads = {
  title: { label: 'Title', span: 'right', render },
  story: { label: 'Story', parameters: { heading: p.string({ label: 'Heading', default: '', maxLength: 10 }) }, render },
  closing: { label: 'Closing', span: 'left', render },
};
const declare = (openingSpreads: unknown, formats: Record<string, unknown> = { single: pages('single-pages') }) =>
  templateSchema.safeParse({ id: 't', version: '1', contract: 1, formats, spreads, openingSpreads });
const messages = (result: ReturnType<typeof declare>) => result.success ? [] : result.error.issues.map(({ path, message }) => path.join('.') + ': ' + message);

test('opening spreads are optional, and valid ones reach templateInfo with their order and values', () => {
  assert.ok(declare(undefined).success);
  const result = declare([{ layout: 'title' }, { layout: 'story', params: { heading: 'Day one' } }, { layout: 'closing' }]);
  assert.ok(result.success, messages(result).join('\n'));
  const info = templateInfo(chooseFormat(result.data));
  assert.deepEqual(info.openingSpreads, [
    { layout: 'title', params: {} }, { layout: 'story', params: { heading: 'Day one' } }, { layout: 'closing', params: {} },
  ]);
  assert.deepEqual(templateInfo(chooseFormat(declare(undefined).data!)).openingSpreads, []);
});

test('opening spreads must name declared layouts and set their own parameters to allowed values', () => {
  assert.deepEqual(messages(declare([{ layout: 'cover' }])),
    ['openingSpreads.0.layout: Layout cover is not declared in spreads. Declared layouts: title, story, closing.']);
  assert.deepEqual(messages(declare([{ layout: 'story', params: { subtitle: 'x', heading: 'Far too long a heading' } }])), [
    'openingSpreads.0.params.subtitle: Layout story has no parameter subtitle.',
    'openingSpreads.0.params.heading: "Far too long a heading" is not an allowed value for Heading in layout story.',
  ]);
  assert.ok(!declare([{ layout: 'story', extra: true }]).success);
});

test('single pages in opening spreads must sit at a book end every format allows', () => {
  assert.deepEqual(messages(declare([{ layout: 'story' }, { layout: 'title' }])),
    ['openingSpreads.1.layout: Layout title is a single right page. In format single it can only be the first opening spread.']);
  assert.deepEqual(messages(declare([{ layout: 'closing' }, { layout: 'story' }])),
    ['openingSpreads.0.layout: Layout closing is a single left page. In format single it can only be the last opening spread.']);
  // A format without single pages at the ends rejects them anywhere.
  assert.deepEqual(messages(declare([{ layout: 'title' }, { layout: 'story' }], { single: pages('single-pages'), covers: pages('inside-covers') })),
    ['openingSpreads.0.layout: Layout title is a single right page. Format covers has no single pages at the book ends.']);
});

test('a new book gets the opening spreads with fresh IDs, and an empty book is a valid project', () => {
  const opening = [{ layout: 'title' }, { layout: 'story', params: { heading: 'Day one' } }];
  const first = openingSpreadStates({ openingSpreads: opening });
  const second = openingSpreadStates({ openingSpreads: opening });
  assert.deepEqual(first.map(({ definition, params }) => ({ definition, params })), [
    { definition: 'title', params: {} }, { definition: 'story', params: { heading: 'Day one' } }]);
  assert.notEqual(first[0].id, second[0].id);
  assert.notEqual(first[0].id, first[1].id);
  assert.deepEqual(openingSpreadStates({}), []);
  const project = { schemaVersion: 1, title: 'New', template: { id: 't', version: '1' }, spreads: [] };
  assert.ok(projectSchema.safeParse(project).success);
  assert.ok(projectSchema.safeParse({ ...project, spreads: first }).success);
});

test('an empty book starts with a single right page where the format requires one, else with facing pages', () => {
  const layouts = { title: { span: 'right' }, story: { span: 'spread' }, closing: { span: 'left' } } as never;
  assert.deepEqual(firstSpreadLayouts(layouts, pages('single-pages')), ['title']);
  assert.deepEqual(firstSpreadLayouts(layouts, pages('inside-covers')), ['story']);
});

test('opening page pairs validate sides and materialize independent format-2 states', () => {
  const layouts = { page: { label: 'Page', span: 'page', parameters: { heading: p.string({ label: 'Heading', default: '' }) }, render },
    right: { label: 'Right only', span: 'page', sides: ['right'], render } };
  const parsed = templateSchema.parse({ id: 'pages', version: '1', contract: 1, format: pages('inside-covers'), spreads: layouts,
    openingSpreads: [{ pages: { left: { layout: 'page', params: { heading: 'Left' } }, right: { layout: 'right' } } }, { pages: { left: {} } }] });
  const info = templateInfo(chooseFormat(parsed));
  const states = openingSpreadStates(info);
  assert.equal(states[0].split, true);
  assert.equal(states[0].pages!.left!.params.heading, 'Left');
  assert.equal(states[0].pages!.right!.definition, 'right');
  assert.equal(states[1].pages!.left!.definition, undefined);
  assert.equal(projectSchema.parse({ schemaVersion: 1, title: 'Pages', template: { id: 'pages', version: '1' }, spreads: states }).schemaVersion, 2);
  states[0].pages!.left!.params.heading = 'Edited';
  assert.equal(openingSpreadStates(info)[0].pages!.left!.params.heading, 'Left');
});

test('opening page pairs reject spread layouts, side restrictions, invalid parameters and end positions', () => {
  const declaration = (entry: unknown, format = pages('inside-covers')) => templateSchema.safeParse({ id: 'pages', version: '1', contract: 1, format,
    spreads: { spread: { label: 'Spread', render }, right: { label: 'Right', span: 'page', sides: ['right'], render } }, openingSpreads: [entry] });
  for (const entry of [{ pages: { left: { layout: 'spread' } } }, { pages: { left: { layout: 'right' } } },
    { pages: { right: { layout: 'missing' } } }, { pages: { right: { layout: 'right', params: { unknown: true } } } }, { pages: {} }]) {
    assert.equal(declaration(entry).success, false, JSON.stringify(entry));
  }
  assert.equal(declaration({ pages: { right: { layout: 'right' } } }, pages('single-pages')).success, false);
  assert.equal(declaration({ pages: { right: { layout: 'right' } } }, printFormat({ facingPages: false, label: 'Calendar',
    trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(5), pageCount: { min: 1, max: 20, step: 1 } }) as never).success, false);
});

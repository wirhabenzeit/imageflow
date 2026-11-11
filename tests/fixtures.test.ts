import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createAuthoringService } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import type { BookPreview } from '../desktop/preview';
import { loadProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { contactSheetLayout, fixtureBannerHeight } from '../src/authoring-artwork';
import type { AuthoringCheckResult } from '../src/authoring-check';
import type { RenderStatus, TemplateInfo } from '../src/desktop';
import { fixtureMarkdown, fixtureProject, fixtureRequestSchema, planFixtures } from '../src/fixtures';
import type { FixtureSourceIds } from '../src/fixtures';
import { mm } from '../src/format';
import type { PrintFormat } from '../src/format';
import { parseMcpArguments } from '../src/mcp-contract';
import { p } from '../src/parameters';
import { PreviewError } from '../src/preview';
import type { PreviewRequest } from '../src/preview';
import type { Project } from '../src/project';

const format = (label: string, width: number): PrintFormat => ({
  label, trim: { width: mm(width), height: mm(200) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(10), bottom: mm(10), outside: mm(10), binding: mm(10) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 200, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
});
const template: TemplateInfo = {
  version: '1', parameters: {}, formatId: 'square', formats: { square: 'Square', landscape: 'Landscape' }, format: format('Square', 200),
  spreads: {
    main: { label: 'Story', span: 'spread', parameters: { heading: p.string({ label: 'Heading', default: 'North', multiline: true, maxLength: 40 }) },
      boxes: { hero: { type: 'photo', label: 'Hero', parameters: {} }, story: { type: 'markdown', label: 'Story', parameters: {} } }, elements: {} },
    chapter: { label: 'Divider', span: 'spread', parameters: {}, boxes: {}, elements: {} },
    map: { label: 'Map', span: 'spread', parameters: {}, boxes: {},
      elements: { route: { label: 'Route', parameters: { track: p.file({ label: 'Track', accept: ['.gpx'] }) } } } },
    cover: { label: 'Cover', span: 'right', parameters: { title: p.string({ label: 'Title', default: '', placeholder: 'Summer' }) }, boxes: {}, elements: {} },
  },
};
const ids: FixtureSourceIds = { photo: { landscape: 'land', portrait: 'port' }, file: (extension) => 'file' + extension.replace('.', '-') };
const plan = (request: unknown = {}) => planFixtures(template, fixtureRequestSchema.parse(request));

test('fixture plans cover every applicable layout and case and list what they skip', () => {
  const result = plan();
  assert.deepEqual(result.formats, ['square']);
  assert.deepEqual(result.cells.map(({ layout, case: fixture }) => layout + '/' + fixture), [
    'main/typical', 'main/long-text', 'main/empty', 'main/portrait-photos',
    'chapter/typical',
    'map/typical', 'map/empty', 'map/malformed-files',
    'cover/typical', 'cover/long-text', 'cover/empty',
  ]);
  assert.ok(result.skipped.some(({ layout, case: fixture, reason }) => layout === 'chapter' && fixture === 'long-text' && /no string/.test(reason)));
  assert.ok(result.skipped.some(({ layout, case: fixture }) => layout === 'main' && fixture === 'malformed-files'));
  assert.ok(result.skipped.some(({ format: skipped, reason }) => skipped === 'landscape' && /Not requested/.test(reason)));
  assert.equal(new Set(result.cells.map(({ spread }) => spread)).size, result.cells.length);
  assert.equal(result.cells[1].label, 'Story · Long text');

  assert.deepEqual(plan({ formats: 'all' }).formats, ['square', 'landscape']);
  assert.ok(!plan({ formats: 'all' }).skipped.some(({ format: skipped }) => skipped));
  assert.throws(() => plan({ layouts: ['missing'] }), { code: 'LAYOUT_NOT_FOUND' });
  assert.throws(() => plan({ formats: ['a4'] }), { code: 'FORMAT_NOT_FOUND' });
  assert.throws(() => plan({ preview: { cells: [{ layout: 'chapter', case: 'empty' }] } }), { code: 'FIXTURE_NOT_FOUND' });
  assert.throws(() => plan({ formats: ['square'], preview: { printFormat: 'landscape' } }), { code: 'FIXTURE_NOT_FOUND' });
  const preview = plan({ layouts: ['main'], cases: ['empty', 'typical'], preview: { cells: [{ layout: 'main', case: 'empty' }] } });
  assert.deepEqual(preview.cells.map(({ case: fixture }) => fixture), ['empty', 'typical']);
  assert.deepEqual(preview.preview?.cells.map(({ case: fixture }) => fixture), ['empty']);
  assert.equal(preview.preview?.maxEdge, 1200);
});

test('fixture plans stay bounded and report the cells they leave out', () => {
  const many: TemplateInfo = { ...template, spreads: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['layout' + i, template.spreads.main])) };
  const result = planFixtures(many, fixtureRequestSchema.parse({}));
  assert.equal(result.layouts.length, 24);
  assert.equal(result.cells.length, 48);
  assert.ok(result.skipped.some(({ layout, case: fixture, reason }) => layout === 'layout24' && !fixture && /24 layouts/.test(reason)));
  assert.ok(result.skipped.some(({ reason }) => /48 fixtures/.test(reason)));
  assert.ok(!fixtureRequestSchema.safeParse({ layouts: Array.from({ length: 25 }, (_, i) => 'l' + i) }).success);
});

test('fixture spreads carry synthetic content for each case without touching saved spreads', () => {
  const saved: Project = { schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, format: 'square',
    params: { tone: 'warm' }, texts: { real: 'texts/real.md' }, files: {}, spreads: [{ id: 'one', definition: 'main', params: {}, boxes: {}, elements: {} }] };
  const cells = plan({ formats: ['landscape'] }).cells;
  const { project, markdown } = fixtureProject(saved, template, 'landscape', cells, ids);
  assert.equal(project.format, 'landscape');
  assert.deepEqual(project.params, { tone: 'warm' });
  assert.equal(saved.spreads.length, 1);
  assert.deepEqual(project.spreads.map(({ id }) => id), cells.map(({ spread }) => spread));
  const spread = (layout: string, fixture: string) => project.spreads.find(({ id }) => id === 'fixture-' + fixture + '-' + layout)!;

  assert.equal(spread('main', 'typical').params.heading, 'North');
  assert.equal(spread('main', 'typical').boxes.hero.photo, 'land');
  assert.equal(spread('main', 'portrait-photos').boxes.hero.photo, 'port');
  const long = spread('main', 'long-text');
  assert.equal(String(long.params.heading).length, 40);
  assert.equal(markdown[String(long.boxes.story.text)], fixtureMarkdown.long);
  assert.ok(fixtureMarkdown.long.split(/\s+/).length > 2000);
  assert.notEqual(long.boxes.story.text, spread('main', 'typical').boxes.story.text);
  assert.equal(markdown[String(spread('main', 'typical').boxes.story.text)], fixtureMarkdown.typical);
  const empty = spread('main', 'empty');
  assert.equal(empty.params.heading, '');
  assert.equal(empty.boxes.hero.photo, undefined);
  assert.equal(empty.boxes.story.text, undefined);
  assert.equal(spread('map', 'malformed-files').elements.route.params.track, 'file-gpx');
  assert.equal(spread('map', 'typical').elements.route.params.track, undefined);
  assert.equal(spread('cover', 'typical').params.title, 'Summer');
  assert.equal(project.texts.real, 'texts/real.md');
});

test('fixture contact sheets reserve a banner inside the requested edge', () => {
  for (const maxEdge of [128, 600, 1600]) {
    const header = fixtureBannerHeight(maxEdge);
    const sizes = [{ widthMm: 400, heightMm: 200 }, { widthMm: 200, heightMm: 200 }, { widthMm: 200, heightMm: 300 }];
    const grid = contactSheetLayout(sizes, maxEdge, 2, header);
    assert.ok(Math.max(grid.width, grid.height) <= maxEdge);
    assert.ok(grid.cells.every(({ y, label }) => y >= header && label.y + label.height <= grid.height));
  }
  assert.deepEqual(contactSheetLayout([{ widthMm: 100, heightMm: 100 }], 400, 1), contactSheetLayout([{ widthMm: 100, heightMm: 100 }], 400, 1, 0));
});

test('check_book accepts fixtures only on their own', () => {
  const project = 'handle';
  assert.doesNotThrow(() => parseMcpArguments('check_book', { project, fixtures: { formats: 'all', preview: {} } }));
  assert.throws(() => parseMcpArguments('check_book', { project, fixtures: {}, preview: { target: { spread: 'one' } } }), /fixtures/);
  assert.throws(() => parseMcpArguments('check_book', { project, fixtures: { cases: ['huge'] } }));
  assert.throws(() => parseMcpArguments('check_book', { project, fixtures: { preview: { maxEdge: 64 } } }));
});

const saved = { schemaVersion: 1, title: 'Fixture book', template: { id: 'test', version: '1' }, format: 'square',
  spreads: [{ id: 'one', definition: 'main' }, { id: 'two', definition: 'chapter' }] };
type Render = { book: OpenProject; preview?: PreviewRequest };
// `fails` lets a test make a fixture book throw, either naming the failing spreads or as a whole.
type Failure = (book: OpenProject) => { spreads?: string[]; message: string } | undefined;

async function service(t: TestContext, fails?: Failure) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-fixtures-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'book'), cache = join(work, 'cache');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify(saved));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), 'export default {};');
  await writeFile(join(work, 'api.md'), '# API');
  const session = new ProjectSession(await loadProject(folder, cache, true));
  t.after(() => session.close());
  const renders: Render[] = [];
  const statusFor = (book: OpenProject): Extract<RenderStatus, { state: 'ready' }> => {
    const errors: Extract<RenderStatus, { state: 'ready' }>['errors'] = [
      { message: 'Page count is odd.', code: 'page-sequence' },
    ];
    const warnings: typeof errors = [];
    for (const spread of book.project.spreads) {
      if (spread.id.startsWith('fixture-long-text-main')) {
        errors.push({ message: 'Text does not fit.', code: 'text-overflow', spread: spread.id, where: 'Pages 1–2 · Story', box: 'story',
          source: spread.boxes.story?.text, details: { overflowCharacters: 900, boxes: 1, path: 'synthetic/long-text.md' } });
      }
      if (spread.definition === 'main' && spread.boxes.hero?.photo) {
        warnings.push({ message: 'Low resolution.', code: 'photo-resolution-low', spread: spread.id, box: 'hero' });
      }
      if (spread.id === 'fixture-long-text-cover') warnings.push({ message: 'Title is outside the safe area.', code: 'text-outside-safe-area', spread: spread.id });
    }
    return { state: 'ready', template, pages: book.project.spreads.length * 2, units: [], errors, warnings, flow: {}, anchors: [] };
  };
  const hooks: Parameters<typeof createAuthoringService>[0] = {
    session: () => session, cache, docs: join(work, 'api.md'),
    check: (book, request, signal, index, draft) => checkProject(book, cache, request, async (snapshot, preview) => {
      renders.push({ book: snapshot, preview });
      const failure = snapshot.fixture ? fails?.(snapshot) : undefined;
      if (failure) {
        throw new PreviewError('render-failed', failure.message, { template,
          failure: { layoutFailures: failure.spreads?.map((spread) => ({ spread, message: failure.message })) } });
      }
      const status = statusFor(snapshot);
      if (!preview) return { status };
      const target = preview.target as { spreads: string[] };
      const image: BookPreview = { kind: 'contact-sheet', width: 300, height: 200, bounds: 'trim', columns: 3,
        banner: { text: snapshot.fixture?.banner ?? '', height: 14 },
        cells: target.spreads.map((spread) => ({ spread, x: 0, y: 14, width: 10, height: 10, widthMm: 400, heightMm: 200, bounds: 'trim' as const,
          side: 'spread' as const, page: {}, label: 'FIXTURE · ' + snapshot.fixture?.labels[spread] })),
        bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', status };
      return { status, preview: image };
    }, signal, index, undefined, draft),
    changed: () => assert.fail('Fixtures must not change the book.'),
    recovery: (message) => assert.fail('Unexpected save recovery: ' + message),
    import: async () => assert.fail('Fixtures must not import sources.'),
  };
  const run = createAuthoringService(hooks);
  const call = (name: string, args: Record<string, unknown> = {}) => run(name, { project: session.handle, ...args }, new AbortController().signal);
  return { folder, session, renders, call, cache };
}

test('fixture checks render unused layouts per format with synthetic content and never save', async (t) => {
  const { folder, session, renders, call } = await service(t);
  const before = await readFile(join(folder, 'project.json'), 'utf8');
  const history = structuredClone(session.history);
  const result = await call('check_book', { fixtures: { formats: 'all', layouts: ['main', 'cover'], preview: { printFormat: 'landscape',
    cells: [{ layout: 'main', case: 'long-text' }, { layout: 'cover', case: 'typical' }] } } }) as AuthoringCheckResult;

  assert.equal(result.state, 'ready');
  assert.equal(result.checks.layout, 'completed');
  assert.equal(result.checks.fixtures, 'completed');
  // The saved book keeps its own diagnostics; fixture findings are reported apart from them.
  assert.ok(result.diagnostics.some(({ code }) => code === 'page-sequence'));
  assert.ok(!result.diagnostics.some(({ location }) => location?.spread?.startsWith('fixture-')));
  const report = result.fixtures!;
  assert.equal(report.synthetic, true);
  assert.equal(report.committed, false);
  assert.equal(report.revision, result.revision);
  assert.deepEqual(report.matrix.formats, ['square', 'landscape']);
  assert.deepEqual(report.matrix.layouts, ['main', 'cover']);
  assert.equal(report.coverage.planned, 14);
  assert.equal(report.coverage.rendered, 14);
  assert.equal(report.cells.length, 14);
  assert.ok(report.coverage.skipped.some(({ layout, case: fixture }) => layout === 'main' && fixture === 'malformed-files'));
  const long = report.cells.find((cell) => cell.layout === 'main' && cell.case === 'long-text' && cell.format === 'landscape')!;
  assert.deepEqual([long.state, long.errors, long.codes], ['errors', 1, ['text-overflow']]);
  // Synthetic photos cannot judge resolution, and the arrangement of a fixture book is not a page-sequence finding.
  assert.ok(!report.diagnostics.some(({ code }) => code === 'photo-resolution-low' || code === 'page-sequence'));
  const overflow = report.diagnostics.find(({ code }) => code === 'text-overflow')!;
  assert.deepEqual(overflow.fixture, { layout: 'main', case: 'long-text', format: 'square' });
  assert.equal(overflow.location?.spread, undefined);
  assert.equal(overflow.location?.where, 'Fixture · Story · Long text');
  assert.equal(overflow.details?.path, undefined);
  assert.match(overflow.suggestion ?? '', /Synthetic text/);
  assert.equal(report.cells.find((cell) => cell.layout === 'cover' && cell.case === 'long-text')?.state, 'warnings');
  assert.ok(report.notEvaluated.some((line) => /Print preflight/.test(line)));

  // One render for the saved book, then one fixture book per format.
  const books = renders.filter(({ book }) => book.fixture);
  assert.equal(renders.length, 3);
  assert.deepEqual(books.map(({ book }) => book.project.format), ['square', 'landscape']);
  for (const { book } of books) {
    assert.deepEqual(book.project.spreads.map(({ id }) => id), report.cells.filter(({ format: tested }) => tested === book.project.format)
      .map(({ layout, case: fixture }) => 'fixture-' + fixture + '-' + layout));
    assert.match(book.fixture!.banner, /^SYNTHETIC FIXTURES · (Square|Landscape) · not the saved book$/);
    const photo = book.photos.get('fixture-photo-portrait')!;
    assert.equal(photo.cache, book.cache);
    assert.ok(photo.height > photo.width);
    assert.ok((await stat(photo.original)).isFile());
    assert.equal(book.texts['fixture-text-long-text-main'], fixtureMarkdown.long);
  }
  assert.equal(books[0].preview, undefined);
  assert.deepEqual(books[1].preview?.target, { spreads: ['fixture-long-text-main', 'fixture-typical-cover'], columns: 3 });

  assert.equal(result.image?.fixture, true);
  assert.equal(result.image?.draft, undefined);
  assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), before);
  assert.deepEqual(session.history, history);
});

test('a layout that throws on fixture content fails only its fixture', async (t) => {
  const { renders, call } = await service(t, (book) => {
    const failing = book.project.spreads.filter(({ id }) => id === 'fixture-malformed-files-map' || id === 'fixture-empty-cover').map(({ id }) => id);
    return failing.length ? { spreads: failing, message: 'Cannot read the track.' } : undefined;
  });
  const result = await call('check_book', { fixtures: { preview: { cells: [{ layout: 'map', case: 'malformed-files' }, { layout: 'main', case: 'typical' }] } } }) as AuthoringCheckResult;
  const report = result.fixtures!;
  assert.equal(result.checks.fixtures, 'completed');
  assert.equal(report.coverage.failed, 2);
  assert.equal(report.coverage.rendered, report.coverage.planned - 2);
  const map = report.cells.find(({ layout, case: fixture }) => layout === 'map' && fixture === 'malformed-files')!;
  assert.deepEqual([map.state, map.message, map.codes], ['failed', 'Cannot read the track.', ['layout-render-failed']]);
  assert.ok(report.diagnostics.some(({ code, fixture }) => code === 'layout-render-failed' && fixture.layout === 'cover' && fixture.case === 'empty'));
  // The first fixture render names the failures; the second renders the rest, including what remains of the requested sheet.
  const books = renders.filter(({ book }) => book.fixture);
  assert.equal(books.length, 2);
  assert.ok(!books[1].book.project.spreads.some(({ id }) => id === 'fixture-malformed-files-map'));
  assert.deepEqual(books[1].preview?.target, { spreads: ['fixture-typical-main'], columns: 3 });
  assert.equal(result.image?.fixture, true);
});

test('an unattributed fixture failure is bisected within the render budget', async (t) => {
  const { call } = await service(t, (book) => book.project.spreads.some(({ id }) => id === 'fixture-typical-chapter')
    ? { message: 'Anchors could not be declared.' } : undefined);
  const result = await call('check_book', { fixtures: {} }) as AuthoringCheckResult;
  const report = result.fixtures!;
  const chapter = report.cells.find(({ layout }) => layout === 'chapter')!;
  assert.deepEqual([chapter.state, chapter.message], ['failed', 'Anchors could not be declared.']);
  assert.equal(report.coverage.failed, 1);
  assert.equal(report.coverage.notIsolated, 0);
  assert.equal(report.coverage.rendered, report.coverage.planned - 1);
  assert.equal(result.checks.fixtures, 'completed');
});

test('fixture checks require a loaded template and the expected revision', async (t) => {
  const { folder, call } = await service(t);
  const stale = await call('check_book', { expectedRevision: 'a'.repeat(64), fixtures: {} }) as AuthoringCheckResult;
  assert.equal(stale.fixtures, undefined);
  assert.equal(stale.checks.fixtures, 'not-run');
  assert.ok(stale.diagnostics.some(({ code }) => code === 'revision-conflict'));
  await assert.rejects(call('check_book', { fixtures: { layouts: ['missing'] } }), { code: 'LAYOUT_NOT_FOUND' });
  await writeFile(join(folder, 'template/index.tsx'), 'export default { broken syntax');
  const broken = await call('check_book', { fixtures: {} }) as AuthoringCheckResult;
  assert.equal(broken.checks.bundle, 'failed');
  assert.equal(broken.checks.fixtures, 'not-run');
});

test('fixture isolation starts no render after the time budget runs out', async (t) => {
  // A controlled clock: the first isolation render (the first half of the bisection) takes past the 60-second budget.
  let now = 1_000_000, fixtureRenders = 0;
  t.mock.method(Date, 'now', () => now);
  const { renders, call } = await service(t, (book) => {
    if (++fixtureRenders === 2) now += 61_000;
    return book.project.spreads.some(({ id }) => id === 'fixture-typical-chapter') ? { message: 'Anchors could not be declared.' } : undefined;
  });
  const result = await call('check_book', { fixtures: {} }) as AuthoringCheckResult;
  const report = result.fixtures!;
  // The full fixture book, then the first half. Neither its own halves nor the second half start after the deadline.
  assert.equal(renders.filter(({ book }) => book.fixture).length, 2);
  assert.equal(report.coverage.rendered, 0);
  assert.equal(report.coverage.notIsolated, report.coverage.planned);
  assert.ok(report.cells.every(({ state, message }) => state === 'not-isolated' && /budget ran out: Anchors could not be declared/.test(message ?? '')));
  assert.equal(result.checks.fixtures, 'failed');
});

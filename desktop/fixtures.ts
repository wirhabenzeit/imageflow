import { mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { FixtureCellReport, FixtureReport } from '../src/authoring-check';
import type { TemplateInfo } from '../src/desktop';
import { fixtureProject } from '../src/fixtures';
import type { FixtureCell, FixtureSourceIds } from '../src/fixtures';
import type { PreviewRequest } from '../src/preview';
import type { ProjectFile } from '../src/project';
import type { CheckDraft } from './check';
import { photoDetails } from './photos';
import type { ProjectPhoto } from './photos';
import { withProjectFiles } from './project';
import type { OpenProject } from './project';

type FixturePhoto = Omit<ProjectPhoto, 'cache'>;
export type FixtureAssets = { landscape: FixturePhoto; portrait: FixturePhoto };

// A recognisably synthetic test image: graded sky and ground, a ten-percent grid, thirds and a centre mark. It shows how
// a frame crops a photo without resembling any real picture.
function patternSvg(width: number, height: number) {
  const lines: string[] = [];
  for (let i = 1; i < 10; i++) {
    lines.push('<line x1="' + width * i / 10 + '" y1="0" x2="' + width * i / 10 + '" y2="' + height + '"/>',
      '<line x1="0" y1="' + height * i / 10 + '" x2="' + width + '" y2="' + height * i / 10 + '"/>');
  }
  const stroke = Math.round(Math.max(width, height) / 400);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#7fa7c9"/><stop offset="0.62" stop-color="#d9e4ea"/><stop offset="0.62" stop-color="#6f8a5a"/>' +
    '<stop offset="1" stop-color="#3f5636"/></linearGradient></defs>' +
    '<rect width="100%" height="100%" fill="url(#g)"/>' +
    '<g stroke="#ffffff" stroke-opacity="0.35" stroke-width="' + stroke + '">' + lines.join('') + '</g>' +
    '<g stroke="#c0392b" stroke-width="' + stroke * 2 + '" fill="none">' +
    '<line x1="' + width / 3 + '" y1="0" x2="' + width / 3 + '" y2="' + height + '"/><line x1="' + width * 2 / 3 + '" y1="0" x2="' + width * 2 / 3 + '" y2="' + height + '"/>' +
    '<line x1="0" y1="' + height / 3 + '" x2="' + width + '" y2="' + height / 3 + '"/><line x1="0" y1="' + height * 2 / 3 + '" x2="' + width + '" y2="' + height * 2 / 3 + '"/>' +
    '<circle cx="' + width / 2 + '" cy="' + height / 2 + '" r="' + Math.min(width, height) / 12 + '"/>' +
    '<rect x="' + stroke + '" y="' + stroke + '" width="' + (width - stroke * 2) + '" height="' + (height - stroke * 2) + '"/></g></svg>';
}

const assetVersion = 'fixture-photos-1';
let pending: { folder: string; work: Promise<FixtureAssets> } | undefined;

/** Synthetic photos for fixture books, generated once per app session under the app cache. */
export function fixtureAssets(cacheRoot: string): Promise<FixtureAssets> {
  const folder = join(cacheRoot, assetVersion);
  if (pending?.folder === folder) return pending.work;
  const work = (async () => {
    await mkdir(folder, { recursive: true });
    const actual = await realpath(folder);
    const make = async (name: string, width: number, height: number, title: string): Promise<FixturePhoto> => {
      const path = join(actual, name + '.jpg');
      const exists = await stat(path).then((info) => info.isFile(), () => false);
      if (!exists) {
        const staging = await mkdtemp(join(actual, '.make-'));
        try {
          const candidate = join(staging, name + '.jpg');
          await sharp(Buffer.from(patternSvg(width, height))).jpeg({ quality: 85 }).toFile(candidate);
          await rename(candidate, path);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      return { ...await photoDetails(path), original: path, title, altText: title };
    };
    const [landscape, portrait] = await Promise.all([
      make('landscape-3x2', 2400, 1600, 'Synthetic landscape photo (3:2)'),
      make('portrait-2x3', 1600, 2400, 'Synthetic portrait photo (2:3)'),
    ]);
    return { landscape, portrait };
  })();
  pending = { folder, work };
  work.catch(() => { if (pending?.work === work) pending = undefined; });
  return work;
}

export const fixtureSourceIds = {
  photo: { landscape: 'fixture-photo-landscape', portrait: 'fixture-photo-portrait' },
  file: (extension: string) => 'fixture-file-' + extension.slice(1),
} satisfies FixtureSourceIds;

/** Builds the synthetic book for one format from the freshly loaded, revision-verified book. */
export function fixtureDraft(template: TemplateInfo, format: string, cells: FixtureCell[], assets: FixtureAssets,
  preview?: PreviewRequest): CheckDraft {
  return (book) => {
    const extensions = new Set<string>();
    const ids: FixtureSourceIds = { ...fixtureSourceIds, file: (extension) => { extensions.add(extension); return fixtureSourceIds.file(extension); } };
    const { project, markdown } = fixtureProject(book.project, template, format, cells, ids);
    const files: Record<string, ProjectFile> = { ...book.files };
    for (const extension of extensions) {
      const id = fixtureSourceIds.file(extension);
      project.files = { ...project.files, [id]: 'synthetic/malformed' + extension };
      files[id] = { name: 'malformed' + extension, extension,
        text: 'This synthetic fixture is not a valid ' + extension + ' file.\n<<< truncated \u0000 data\n{ "unterminated": [1, 2,\n' };
    }
    const photoIndex = { ...book.photoIndex,
      [ids.photo.landscape]: { path: 'synthetic/landscape-3x2.jpg', title: assets.landscape.title, altText: assets.landscape.altText },
      [ids.photo.portrait]: { path: 'synthetic/portrait-2x3.jpg', title: assets.portrait.title, altText: assets.portrait.altText } };
    const drafted = withProjectFiles(book, { project, photoIndex });
    const photos = new Map(drafted.photos);
    photos.set(ids.photo.landscape, { ...assets.landscape, cache: book.cache });
    photos.set(ids.photo.portrait, { ...assets.portrait, cache: book.cache });
    const formatLabel = template.formats[format] ?? template.format.label;
    const fixtureBook: OpenProject = {
      ...drafted, photos, files, texts: { ...book.texts, ...markdown },
      fixture: { banner: 'SYNTHETIC FIXTURES · ' + formatLabel + ' · not the saved book',
        labels: Object.fromEntries(cells.map((cell) => [cell.spread, cell.label])) },
    };
    return { book: fixtureBook, fixture: true, ...(preview ? { preview } : {}) };
  };
}

export const fixtureNotEvaluated = [
  'Photo resolution: synthetic photos stand in for real originals, so photo-resolution-low findings are omitted.',
  'Page count, page sequence and book ends: fixture books place layouts side by side regardless of span.',
  'Anchors declared on other spreads, document parameter and book-level findings: see the saved-book diagnostics.',
  'Parameters other than strings and files keep their declared defaults; crops use the default fill.',
  'Text continuation from the saved book: each fixture flows its own synthetic Markdown.',
  'Print preflight.',
];
// Findings that describe the synthetic book's arrangement rather than the layout under test.
const ignoredCodes = new Set(['page-sequence', 'photo-resolution-low', 'anchor-missing', 'anchor-ambiguous', 'project-input', 'format-unavailable']);

export function fixtureFindings(diagnostics: AuthoringDiagnostic[], cells: FixtureCell[], format: string) {
  const bySpread = new Map(cells.map((cell) => [cell.spread, cell]));
  return diagnostics.flatMap((diagnostic) => {
    const cell = diagnostic.location?.spread ? bySpread.get(diagnostic.location.spread) : undefined;
    if (!cell || ignoredCodes.has(diagnostic.code)) return [];
    const { spread: _spread, where: _where, ...location } = diagnostic.location!;
    const finding = { ...diagnostic, location: { ...location, where: 'Fixture · ' + cell.label }, fixture: { layout: cell.layout, case: cell.case, format } };
    if (diagnostic.code === 'text-overflow') {
      finding.suggestion = 'Synthetic text overflowed this layout. In a book, continue the flow on another spread with a Markdown box; ' +
        'check how the overflowing box ends in the fixture image.';
      if (finding.details) {
        const { path: _path, ...details } = finding.details;
        finding.details = details;
      }
    }
    return [finding];
  });
}

export function cellReport(cell: FixtureCell, format: string, findings: FixtureReport['diagnostics']): FixtureCellReport {
  const own = findings.filter(({ fixture }) => fixture.layout === cell.layout && fixture.case === cell.case && fixture.format === format);
  const errors = own.filter(({ severity }) => severity === 'error').length, warnings = own.length - errors;
  return { layout: cell.layout, case: cell.case, format, label: cell.label,
    state: errors ? 'errors' : warnings ? 'warnings' : 'passed', errors, warnings, codes: [...new Set(own.map(({ code }) => code))] };
}


import { editorURL } from './desktop';

// A package in a template's saved dependency bundle (ADR 0006). `license` is the package's declared licence, or ''.
export type TemplatePackage = { name: string; version: string; license: string };

// A template in the template library, as the New Book picker and Manage Templates show it.
export type LibraryEntry = {
  id: string; version: string; label: string; description?: string;
  // Labels of the template's formats and layouts, and how many opening spreads a new book starts with.
  formats: string[]; layouts: string[]; openingSpreads: number;
  shape?: 'Square' | 'Landscape' | 'Portrait';
  // `built-in` templates ship with the app and cannot be removed; an imported template with the same ID replaces one.
  source: 'built-in' | 'imported'; replacesBuiltIn?: boolean;
  importedAt?: string; importedFrom?: string;
  hash: string;
  // What the template's code brings beyond the app (ADR 0006): bundled npm packages and the sites its element editors
  // may reach. `networkTrust` says why books made from this exact version need not ask: it ships with the app, or
  // the user allowed it for this hash. Without it, each book asks once.
  packages?: TemplatePackage[]; network?: string[]; networkTrust?: 'built-in' | 'allowed';
  // How many example spreads a new book can start with instead of the opening spreads: the layouts of a built-in
  // template's sample book, without its content. Absent when there are none or they match the opening spreads.
  exampleSpreads?: number;
  // Development builds only: a new book can start as a copy of the built-in's complete sample book, photos included.
  sampleBook?: boolean;
  // Why this app cannot create a book from the template, such as a feature it requires that the app lacks.
  unavailable?: string;
  // Pictures the views can show at once, from templatePictureURL: the template's own preview `image`, and a saved
  // `render` of its opening spread. `aspect` is the width-to-height ratio of the default format's trimmed page, which
  // the preview image is cropped to.
  image?: boolean; render?: boolean; aspect?: number;
};

/** Where a window loads a picture of a library entry from (see LibraryEntry); keyed by hash, so it never goes stale. */
export const templatePictureURL = (hash: string, kind: 'image' | 'render') => editorURL + 'template-picture/' + hash + '/' + kind;
export const templatePicturePath = /^\/template-picture\/([0-9a-f]{64})\/(image|render)$/;

// What New Book creates: a book from a library template, starting with its example spreads, its opening spreads, or
// (development builds only) a copy of its sample book.
export type NewBookStart = 'examples' | 'opening' | 'sample';
export type NewBookChoice = { id: string; start: NewBookStart };

export function templateFormatSummary(entry: Pick<LibraryEntry, 'shape' | 'formats'>) {
  return [entry.shape, entry.formats.length > 1 ? entry.formats.length + ' formats' : !entry.shape ? entry.formats[0] : ''].filter(Boolean).join(' · ');
}

export type LibraryImportResult = {
  source: string; status: 'imported' | 'replaced' | 'unchanged' | 'cancelled' | 'failed';
  id?: string; label?: string; version?: string; message?: string; details?: string[];
};

/** One line per result, for a summary after importing templates. */
export function describeImport(result: LibraryImportResult) {
  const name = result.label ? result.label + (result.version ? ' ' + result.version : '') : result.source.split(/[\\/]/).pop() ?? result.source;
  switch (result.status) {
    case 'imported': return name + ' was added to the library.';
    case 'replaced': return name + ' replaced the earlier version in the library.';
    case 'unchanged': return name + ' is already in the library.';
    case 'cancelled': return name + ' was not imported.';
    case 'failed': return name + ' could not be imported. ' + (result.message ?? '');
  }
}

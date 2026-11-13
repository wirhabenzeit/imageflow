/** The document's displayed name comes from its package file, including after a Finder rename. */
export const bookName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.imageflow$/i, '') || 'Untitled book';

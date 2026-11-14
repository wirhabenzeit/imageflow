/** Translate missing-file races consistently at the file writer and editor boundaries. */
export function markdownError(error: unknown): Error {
  if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    return new Error('This Markdown source was moved or deleted. Your text is preserved in the editor. Restore the original file and retry.', { cause: error });
  }
  return error instanceof Error ? error : new Error('Could not save this Markdown source.');
}

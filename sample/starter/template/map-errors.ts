// Map loading errors in words: which site failed, and how. No imports, so it is cheap to load and to test.
/**
 * What went wrong loading a map, naming the site that failed: an HTTP error with its status and address, or a site
 * that could not be reached. Only the second can be a missing permission, so only it mentions one.
 */
export function describeLoadError(error: unknown, providers: Record<string, string>) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  const url = message.match(/https?:\/\/[^\s()]+/)?.[0]?.replace(/[.,;:]+$/, '');
  let origin = '';
  try { origin = url ? new URL(url).origin : ''; } catch { /* Not an address after all. */ }
  const site = providers[origin] ?? (origin || 'A map site');
  const status = Number(message.match(/Bad response: (\d{3})/)?.[1] ?? message.match(/\((\d{3})\)/)?.[1] ?? (error as { status?: unknown })?.status);
  if (status >= 400) return site + ' answered HTTP ' + status + (url ? ' for ' + url : '') + '. Try again later, or move the map a little.';
  if (origin && /fetch|network|load failed/i.test(message)) {
    return site + ' could not be reached (' + url + '). Check the internet connection, and that this book may load from ' + origin + '.';
  }
  return message;
}

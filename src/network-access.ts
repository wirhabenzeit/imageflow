// Declared network origins (ADR 0006) the book may not reach yet. They are reported as waiting for the user's
// permission, so a map that fails while a question is open does not look like an unreachable server.

/** The declared origins missing from those the app lets this book reach; none when the app did not say. */
export function pendingNetwork(declared: readonly string[] | undefined, allowed: readonly string[] | undefined) {
  if (!declared?.length || !allowed) return [];
  const reachable = new Set(allowed);
  return declared.filter((origin) => !reachable.has(origin));
}

export const networkPendingSuggestion = (origins: readonly string[]) =>
  'ImageFlow needs the user’s permission before this book may reach ' + origins.join(', ') + '. Ask the user to choose ' +
  'Allow in the ImageFlow window (opening an element editor that uses these sites asks again after Not Now), then check again.';

export function networkPendingIssue(origins: readonly string[]) {
  return {
    message: 'Network access is not allowed yet for ' + origins.join(', ') + '. Pictures that load from these sites cannot draw.',
    code: 'network-permission-pending',
    details: { origins: origins.join(' ') },
    suggestion: networkPendingSuggestion(origins),
  };
}

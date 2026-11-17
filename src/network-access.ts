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

/**
 * What to do about a picture that failed. Permission comes up only when sites are still waiting for it, or when the app
 * did not say what this book may reach; once every declared site is allowed, the failure is the site's or the
 * connection's, and the template's message says which.
 */
export function pictureFailureSuggestion(failure: { timedOut: boolean }, network: {
  declared?: readonly string[]; allowed?: readonly string[]; online?: boolean;
}) {
  const pending = pendingNetwork(network.declared, network.allowed);
  if (pending.length) return networkPendingSuggestion(pending);
  if (network.online === false) return 'This computer is offline. Connect to the internet, then check or export again.';
  if (failure.timedOut) return 'Check the internet connection, then check or export again.';
  if (network.declared?.length && !network.allowed) {
    return 'Check that the template’s network sites are allowed for this book and reachable, then check or export again.';
  }
  return 'Act on the cause the message names: if a site answered with an error such as HTTP 503, try again later; if a site ' +
    'could not be reached, check the internet connection. Then check or export again.';
}

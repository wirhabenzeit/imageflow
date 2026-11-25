/** The edits (a character added, left out or replaced) between two IDs, without regard to case. */
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The IDs most like one that does not exist, best first: what an agent that guessed it probably meant (API-017). */
export function closestIds(id: string, known: readonly string[], limit = 5): string[] {
  const wanted = id.toLowerCase();
  return known.map((candidate) => {
    const other = candidate.toLowerCase();
    // One that starts with the other, of three characters or more: a family's own ID, or one cut short.
    const within = Math.min(wanted.length, other.length) >= 3 && (wanted.startsWith(other) || other.startsWith(wanted));
    return { candidate, within, edits: distance(wanted, other) };
  }).filter(({ candidate, within, edits }) => within || edits <= Math.floor(Math.min(candidate.length, id.length) / 3))
    .sort((a, b) => a.edits - b.edits || (a.candidate < b.candidate ? -1 : 1)).slice(0, limit).map(({ candidate }) => candidate);
}

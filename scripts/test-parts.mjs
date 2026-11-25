// The parts the nightly workflow (.github/workflows/desktop-full.yml) splits the complete suite into.

/** Test files that run the sync engine's scenarios again, each against another store: minutes each on a CI runner. */
export const storeReruns = ['sync-folder-store', 'sync-s3-store', 'sync-cloudkit-engine'];

/** The names of one shard of `count`: every `count`th, so slow neighbours are spread. All shards together are all names. */
export function shardOf(names, shard) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  const [index, count] = match ? match.slice(1).map(Number) : [];
  if (!match || index > count) throw new Error('A shard is one of several, such as 1/2: ' + shard);
  return names.filter((_, position) => position % count === index - 1);
}

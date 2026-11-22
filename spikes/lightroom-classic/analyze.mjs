// Summarizes ~/Documents/ImageFlowSpike/log.jsonl: `node analyze.mjs [path-to-log]`.
// Prints a Markdown table of what each marked action changed (experiment 1 and 2), then the benchmarks.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.argv[2] ?? join(homedir(), 'Documents', 'ImageFlowSpike', 'log.jsonl');
const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

// Each marker owns the changes logged until the next marker.
const groups = [];
let current = { label: '(before the first marker)', changes: [] };
for (const entry of entries) {
  if (entry.kind === 'marker') { groups.push(current); current = { label: entry.label, changes: [] }; }
  else if (entry.kind === 'change') current.changes.push(entry);
}
groups.push(current);

const yes = (value) => (value ? 'yes' : 'no');
const size = (value) => (value && typeof value === 'object' ? `${value.width}×${value.height}` : String(value));
console.log('## Which actions change what\n');
console.log('| Action | editCount | lastEditTime | croppedDimensions | rating/pick | develop hash | masks/retouch in develop | lag (s) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const { label, changes } of groups) {
  if (!changes.length && label.startsWith('(before')) continue;
  const any = (key) => changes.some((change) => key in change.changed);
  const hash = changes.some((change) => change.develop?.changed);
  const sawDevelop = changes.some((change) => change.develop && !change.develop.error);
  const marks = new Set(changes.flatMap((change) => Object.keys(change.develop?.present ?? {})));
  const lags = changes.map((change) => change.lag).filter((lag) => typeof lag === 'number');
  console.log(`| ${label} | ${yes(any('editCount'))} | ${yes(any('lastEditTime'))} | ${yes(any('croppedDimensions'))} | ${yes(any('rating') || any('pickStatus'))} | ${sawDevelop ? yes(hash) : 'n/a'} | ${[...marks].join(', ') || '–'} | ${lags.length ? Math.max(...lags).toFixed(1) : '–'} |`);
}

console.log('\n## Benchmarks\n');
for (const entry of entries) {
  if (entry.kind === 'bench-batch') console.log(`- batch ${entry.photos} photos: median ${(entry.medianSeconds * 1000).toFixed(1)} ms (min ${(entry.minSeconds * 1000).toFixed(1)}, max ${(entry.maxSeconds * 1000).toFixed(1)}); ${entry.singleCalls} single calls: ${(entry.singleCallsSeconds * 1000).toFixed(1)} ms`);
  if (entry.kind === 'bench-batch-stress') console.log(`- stress: ${entry.calls} calls over ${entry.photos} photos in ${entry.totalSeconds.toFixed(2)} s`);
  if (entry.kind === 'watch-tick' || entry.kind === 'watch-stop') console.log(`- watch poll: ${entry.ticks} ticks, average ${(entry.averageSeconds * 1000).toFixed(1)} ms, slowest ${(entry.slowestSeconds * 1000).toFixed(1)} ms`);
  if (entry.kind === 'bench-render') {
    console.log(`- render ${entry.file}: preview ${entry.preview.seconds?.toFixed(2)} s (${entry.preview.width}×${entry.preview.height}, ${entry.preview.bytes} B), full ${entry.full.seconds?.toFixed(2)} s (${entry.full.width}×${entry.full.height}); croppedDimensions ${size(entry.croppedDimensions)} ${entry.fullMatchesCropped ? 'matches' : 'DIFFERS FROM'} the real size; identical preview bytes on re-render: ${yes(entry.identicalPreviewBytes)}, identical image data: ${'identicalPreviewImageData' in entry ? yes(entry.identicalPreviewImageData) : 'n/a'}; editCount ${entry.editCountBefore} → ${entry.editCountAfter}`);
    if (entry.preview.error || entry.full.error) console.log(`  errors: ${entry.preview.error ?? ''} ${entry.full.error ?? ''}`);
  }
  if (entry.kind === 'loopback-ping') console.log(`- loopback: ${entry.calls} POSTs median ${(entry.medianSeconds * 1000).toFixed(1)} ms, max ${(entry.maxSeconds * 1000).toFixed(1)} ms (status ${entry.firstStatus})`);
  if (entry.kind === 'loopback-longpoll') console.log(`- long poll: ${entry.seconds.toFixed(1)} s, other task ticked ${entry.ticksDuring} of ${entry.expectedTicks} times (status ${entry.status})`);
  if (entry.kind === 'loopback-auth') console.log(`- wrong token → status ${entry.status} (401 expected)`);
  if (entry.kind === 'probe-keys') console.log(`- Lightroom ${JSON.stringify(entry.lightroom)}; accepted keys: ${entry.working.join(', ')}; rejected: ${entry.rejected.length}`);
  if (entry.kind === 'identity') console.log(`- identity ${entry.file}: uuid ${entry.values.uuid}, croppedDimensions ${entry.croppedDimensionsType} ${JSON.stringify(entry.values.croppedDimensions)}, resolves by uuid: ${yes(entry.resolvesByUuid)}`);
  if (entry.kind === 'batch-export') {
    console.log(`- batch export ${entry.label}: ${entry.rendered} of ${entry.photos} photos in ${entry.seconds.toFixed(1)} s (${entry.perPhoto?.toFixed(2)} s each, ${(entry.totalBytes / 1e6).toFixed(0)} MB${entry.longEdge ? `, long edge ${entry.longEdge}` : ''}); longest gap for another task ${entry.maxTaskGap.toFixed(2)} s`);
    if (entry.cancel) console.log(`  left the loop after ${entry.cancel.stoppedAfter}; files over the next 20 s: ${entry.cancel.filesOver20s.join(', ')}; session.cancel exists: ${yes(entry.cancel.hasCancelMethod)}`);
    for (const r of entry.renditions) if (r.error || r.revisionChanged) console.log(`  ${r.file}: ${r.error ? `error ${r.error}` : 'revision changed during the batch'}`);
  }
  if (entry.kind === 'batch-export-edit') console.log(`- edit during batch: revision changed ${yes(entry.revisionChangedDuringBatch)}; batch render equals a fresh render ${yes(entry.sameImageAsRenderNow)} (yes = the batch picked up the edit)`);
  if (entry.kind === 'error') console.log(`- ERROR in ${entry.experiment}: ${entry.message}`);
}

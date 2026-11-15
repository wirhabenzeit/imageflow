import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const folder = process.argv[2];
if (!folder) throw new Error('Usage: node scripts/summarize-editor-profile.mjs <recordings folder>');
const recordings = JSON.parse(await readFile(join(folder, 'recordings.json'), 'utf8'));
const max = values => Math.max(0, ...values);
const round = n => Math.round(n * 100) / 100;
const summary = recordings.map(s => {
  const commits = s.events.filter(e => e.type === 'commit');
  const host = commits.filter(e => e.url === 'imageflow://editor/');
  const editor = commits.filter(e => e.url.includes('view=editor'));
  const components = {};
  for (const event of commits) for (const c of event.components) {
    const key = (event.url === 'imageflow://editor/' ? 'host/' : event.url.includes('view=editor') ? 'editor/' : 'render/') + c.name;
    const record = components[key] ??= { renders: 0, sameProps: 0, maxInclusiveMs: 0 };
    record.renders++; record.sameProps += Number(c.sameProps); record.maxInclusiveMs = round(Math.max(record.maxInclusiveMs, c.duration));
  }
  const documents = s.events.filter(e => e.type === 'document');
  return { sample: s.sample, scenario: s.name, error: s.error, elapsedMs: s.elapsed, hostCommits: host.length, hostMaxRenderMs: round(max(host.map(e => e.duration))),
    editorCommits: editor.length, editorMaxRenderMs: round(max(editor.map(e => e.duration))), otherRootCommits: commits.length - host.length - editor.length,
    bookDocuments: documents.filter(e => /[?&]view=book(?:&|$)/.test(e.url)).length,
    thumbnailDocuments: documents.filter(e => /[?&]view=thumbs(?:&|$)/.test(e.url)).length,
    longTasks: s.events.filter(e => e.type === 'longtask').length, maxLongTaskMs: round(max(s.events.filter(e => e.type === 'longtask').map(e => e.duration))),
    frameGapsOver50Ms: s.events.filter(e => e.type === 'frame-gap').length,
    panelStorageWrites: s.events.filter(e => e.type === 'panel-storage-write').length,
    dateFormatCalls: s.events.filter(e => e.type === 'date-format' && e.url === 'imageflow://editor/').length,
    dateFormatMaxMs: round(max(s.events.filter(e => e.type === 'date-format' && e.url === 'imageflow://editor/').map(e => e.duration))),
    captureFactCalls: s.events.filter(e => e.type === 'captureFact').length,
    captureFactMaxMs: round(max(s.events.filter(e => e.type === 'captureFact').map(e => e.duration))),
    photoLoaderCalls: s.events.filter(e => e.type === 'photoLoader').length,
    photoLoaderMaxMs: round(max(s.events.filter(e => e.type === 'photoLoader').map(e => e.duration))), components };
});
await writeFile(join(folder, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(summary.map(s => `${s.sample} ${s.scenario}: host ${s.hostCommits}/${s.hostMaxRenderMs}ms; editor ${s.editorCommits}/${s.editorMaxRenderMs}ms; book ${s.bookDocuments}; long ${s.longTasks}; photo ${s.photoLoaderCalls}/${s.photoLoaderMaxMs}ms${s.error ? ' ERROR ' + s.error : ''}`).join('\n'));
if (!summary.some(s => s.hostMaxRenderMs > 0)) throw new Error('No render timings: use IMAGEFLOW_PROFILE=1 npm run build');
if (summary.some(s => s.error)) process.exitCode = 1;

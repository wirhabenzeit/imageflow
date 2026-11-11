import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'lifecycle-smoke-'));
const first = join(work, 'first');
const second = join(work, 'second');
const third = join(work, 'third');
const moved = join(work, 'moved');
await mkdir(join(first, 'template'), { recursive: true });
await writeFile(join(first, 'template/index.tsx'), `import {defineTemplate,mm,Spread} from 'imageflow';
export default defineTemplate({id:'lifecycle',version:'1',contract:1,
formats:{book:{label:'Book',trim:{width:mm(80),height:mm(110)},
bleed:{top:mm(0),bottom:mm(0),outside:mm(0),binding:mm(0)},safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}}},defaultFormat:'book',
spreads:{base:{label:'Base',render:()=> <Spread><p>Lifecycle test</p></Spread>}}});`);
await writeFile(join(first, 'project.json'), JSON.stringify({ schemaVersion:1, title:'First', template:{id:'lifecycle',version:'1'}, spreads:[{id:'one',definition:'base'}] }));
await writeFile(join(first, 'photos.json'), '{}');
await cp(first, second, { recursive:true });
await cp(first, third, { recursive:true });
const app = await _electron.launch({ executablePath:electron, args:[join(root,'.build/desktop'),'--user-data-dir='+join(work,'profile')], env:{...process.env,IMAGEFLOW_HIDE_WINDOW:'1'} });
let closed = false;
app.on('close', () => { closed = true; });
try {
  const window = await app.firstWindow();
  window.setDefaultTimeout(20000);
  async function open(folder) {
    await app.evaluate(({dialog}, folder) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]}); }, folder);
    const result = await window.evaluate(() => window.imageflow.openProject('open'));
    assert.ok(result.value, JSON.stringify(result));
    return result.value;
  }
  await open(first);
  await rename(first, moved);
  await open(second);
  await open(moved);
  await rm(moved, { recursive:true, force:true });
  await open(second);
  const lockPath = join(second, '.imageflow/writer.lock');
  const oldOwner = JSON.parse(await readFile(lockPath, 'utf8'));
  await writeFile(lockPath, 'damaged ownership evidence');
  await open(third);
  assert.equal(await readFile(lockPath, 'utf8'), 'damaged ownership evidence');
  await assert.rejects(stat(oldOwner.endpoint), { code:'ENOENT' });
  // The test owns this fixture; removing its preserved damaged record permits reopening it.
  await rm(lockPath);
  const book = await open(second);

  // Enabling a connection can be in flight before it is assigned to the window's active connection.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const original = fs.mkdtemp;
    globalThis.connectionGate = { waiting:false, release:null, directory:null };
    fs.mkdtemp = async (...args) => {
      const directory = await original(...args);
      if (String(args[0]).includes('if-mcp-')) {
        fs.mkdtemp = original;
        globalThis.connectionGate.directory = directory;
        globalThis.connectionGate.waiting = true;
        await new Promise(resolve => { globalThis.connectionGate.release = resolve; });
      }
      return directory;
    };
  });
  const enabling = window.evaluate(() => window.imageflow.mcpSettings(true)).catch(() => undefined);
  for (let attempts=0; ; attempts++) {
    if (await app.evaluate(() => globalThis.connectionGate.waiting)) break;
    assert.ok(attempts < 200, 'connection setup reached the gate');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const connectionDirectory = await app.evaluate(() => globalThis.connectionGate.directory);

  // Hold the first manifest rename after its recovery journal is durable, then request normal Quit.
  await app.evaluate(async (_, folder) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const original = fs.rename;
    globalThis.lifecycleGate = { waiting:false, release:null };
    fs.rename = async (...args) => {
      if (args[1] === folder + '/project.json') {
        fs.rename = original;
        globalThis.lifecycleGate.waiting = true;
        await new Promise(resolve => { globalThis.lifecycleGate.release = resolve; });
      }
      return original(...args);
    };
  }, second);
  const files = { project:JSON.parse(await readFile(join(second,'project.json'),'utf8')), photoIndex:{} };
  files.project.title = 'Save completed before quit';
  const saving = window.evaluate(({id,files}) => window.imageflow.saveProject(id, files, 'Shutdown save'), { id:book.id, files }).catch(() => undefined);
  for (let attempts=0; ; attempts++) {
    if (await app.evaluate(() => globalThis.lifecycleGate.waiting)) break;
    assert.ok(attempts < 200, 'save reached the durable rename');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const exited = app.waitForEvent('close');
  await app.evaluate(({app}) => { app.quit(); });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false, 'quit waits for the durable save');
  await stat(join(second,'.imageflow/writer.lock'));
  await stat(join(second,'.imageflow/persistence/pending-save.json'));
  await app.evaluate(() => globalThis.lifecycleGate.release());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false, 'quit also waits for unpublished connection setup');
  await app.evaluate(() => globalThis.connectionGate.release());
  await exited;
  await saving;
  await enabling;
  assert.equal(JSON.parse(await readFile(join(second,'project.json'),'utf8')).title, 'Save completed before quit');
  await assert.rejects(stat(join(second,'.imageflow/writer.lock')), { code:'ENOENT' });
  await assert.rejects(stat(join(second,'.imageflow/persistence/pending-save.json')), { code:'ENOENT' });
  await assert.rejects(stat(connectionDirectory), { code:'ENOENT' });
  await assert.rejects(stat(join(work,'profile/mcp-connection.json')), { code:'ENOENT' });
  console.log('ImageFlow project move, removal, and orderly shutdown passed.');
} finally {
  if (!closed) {
    await app.evaluate(() => globalThis.lifecycleGate?.release?.()).catch(() => {});
    await app.evaluate(() => globalThis.connectionGate?.release?.()).catch(() => {});
    await app.close();
  }
  await rm(work,{recursive:true,force:true});
}

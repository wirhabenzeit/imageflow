import { menuAction, agentSettings, closeSettings } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'mcp-smoke-'));
const folder = join(work, 'book');
await Promise.all(['template', 'inbox', 'photos'].map((name) => mkdir(join(folder, name), { recursive: true })));
const source = `import { defineTemplate, mm, Spread, PhotoBox, p } from 'imageflow';
const format = (label, w, h) => ({label, trim:{width:mm(w),height:mm(h)},
 bleed:{top:mm(0),bottom:mm(0),outside:mm(0),binding:mm(0)},
 safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
 structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},
 output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}});
export default defineTemplate({id:'mcp-test',version:'1',contract:1,
 formats:{portrait:format('Portrait',80,110),landscape:format('Landscape',110,80)},defaultFormat:'portrait',
 parameters:{color:p.color({label:'Color',default:'#0000ff'})},
 spreads:{base:{label:'Base',parameters:{heading:p.string({label:'Heading',default:'Hello'})},
 boxes:{hero:{type:'photo',label:'Photo'}},render:ctx=><Spread><h1 style={{color:ctx.document.color}}>{ctx.params.heading}</h1>
 <PhotoBox id="hero" style={{position:'absolute',left:'10mm',top:'25mm',width:'40mm',height:'40mm'}} /></Spread>}
 // NEW_LAYOUT
 }});`;
const entry = join(folder, 'template/index.tsx');
await Promise.all([
  writeFile(entry, source),
  writeFile(join(folder, 'project.json'), JSON.stringify({schemaVersion:1,title:'MCP book',template:{id:'mcp-test',version:'1'},spreads:[{id:'first',definition:'base'}]})),
  writeFile(join(folder, 'photos.json'), '{}'),
  sharp({create:{width:100,height:100,channels:3,background:'#00ff00'}}).png().toFile(join(folder,'inbox','green.png')),
]);
const app = await _electron.launch({executablePath:electron,args:[join(root,'.build/desktop'),'--user-data-dir='+join(work,'profile')],env:{...process.env,IMAGEFLOW_HIDE_WINDOW:'1'}});
let client;
try {
  const window = await app.firstWindow();
  window.setDefaultTimeout(20000);
  await app.evaluate(({dialog}, folder) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]}); },folder);
  await menuAction(app, 'Open project…');
  const ready = () => window.waitForFunction(()=>document.querySelector('iframe.book-frame-book[data-current][data-ready]') && !document.querySelector('.preview-state'));
  await ready();
  const connectionDialog=await agentSettings(app);
  await connectionDialog.getByRole('checkbox', { name: 'Allow agents to use the open book', exact: true }).check();
  await connectionDialog.getByText('Claude Code and other agents').click();
  const configuration=connectionDialog.getByRole('textbox',{name:'MCP connection configuration'});
  await configuration.waitFor();
  const config=JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  // Agents start the bridge with ImageFlow's own executable in Node mode; no separate Node installation.
  assert.equal(config.command,electron);
  assert.deepEqual(config.env,{ELECTRON_RUN_AS_NODE:'1'});
  assert.match(await connectionDialog.getByRole('textbox',{name:'Claude Code command'}).inputValue(),/^claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 imageflow -- /);
  await connectionDialog.getByText('Waiting for an agent to connect.', { exact: true }).waitFor();
  await closeSettings(app);
  await window.getByRole('button', { name: 'Agent · 0', exact: true }).waitFor();
  client = new Client({name:'ImageFlow prototype test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({...config,stderr:'pipe'}));
  await window.getByRole('button', { name: 'Agent · 1', exact: true }).waitFor();
  // The status-bar indicator opens the Agents pane of Settings.
  const opened=app.waitForEvent('window');
  await window.getByRole('button', { name: 'Agent · 1', exact: true }).click();
  const agents=await opened;
  await agents.getByRole('tab', { name: 'Agents', selected: true }).waitFor();
  await agents.getByText('Connected: ImageFlow prototype test', { exact: true }).waitFor();
  assert.equal((await agents.evaluate(()=>window.imageflow.installMcp('nope'))).error,'Unknown agent.');
  assert.match((await window.evaluate(()=>window.imageflow.installMcp('claude'))).error,/only available to Settings/);
  await closeSettings(app);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['apply_project_changes','check_book','get_authoring_context','import_sources','inspect_book','list_projects'].sort());
  const call = async(name,args={}) => {
    const response=await client.callTool({name,arguments:args},{timeout:110000});
    return {response,data:response.structuredContent ?? JSON.parse(response.content.find(c=>c.type==='text').text)};
  };
  const good = async(name,args={}) => {
    const {response,data}=await call(name,args);
    assert.ok(!response.isError,JSON.stringify(data));
    return data;
  };
  const discovered=await good('list_projects');
  const project=discovered.projects[0].project;
  assert.equal(discovered.projects[0].folder,folder);
  // Typical clients request context and inspection concurrently. Both requests must finish.
  const parallel = await Promise.all([
    good('get_authoring_context',{project}),
    good('inspect_book',{project,view:'summary'}),
    good('list_projects'),
  ]);
  assert.equal(parallel[0].project,project);
  assert.equal(parallel[2].projects[0].project,project);
  let context=await good('get_authoring_context',{project});
  assert.ok(context.apiReference.includes('defineTemplate'));
  assert.ok(context.sources['template/index.tsx'].text.includes('NEW_LAYOUT'));
  assert.equal(context.capabilities.typescript,true);
  assert.equal(context.capabilities.contactSheets,true);
  const check=await call('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  assert.ok(!check.response.isError,JSON.stringify(check.data));
  const image=check.response.content.find(c=>c.type==='image');
  assert.equal((await sharp(Buffer.from(image.data,'base64')).metadata()).width,300);
  assert.equal(check.data.image.data,undefined);
  assert.equal(check.data.checks.typescript,'not-run');
  let revision=check.data.revision;
  await ready();

  // File authoring adds an unused layout; the next tool sees it without a manual reload.
  const authored=source.replace('// NEW_LAYOUT',`, chapter:{label:'Chapter opener',parameters:{heading:p.string({label:'Heading',default:'Chapter'})},render:ctx=><Spread><h1>{ctx.params.heading}</h1></Spread>}`);
  await writeFile(entry,authored);
  context=await good('get_authoring_context',{project});
  assert.ok(context.template.spreads.chapter);
  revision=context.revision;
  await ready();
  const before=await readFile(join(folder,'project.json'),'utf8');
  const batch={project,expectedRevision:revision,idempotencyKey:'chapter-batch',label:'Build landscape chapter',operations:[
    {op:'select_format',format:'landscape'},
    {op:'insert_spread',definition:'chapter',ref:'chapter',after:'first',params:{heading:'A new chapter'}},
    {op:'set_parameter',scope:'document',key:'color',value:'#ff0000'},
  ]};
  const dry=await good('apply_project_changes',{...batch,dryRun:true});
  assert.equal(dry.committed,false);
  assert.equal(await readFile(join(folder,'project.json'),'utf8'),before);
  const overview=await good('check_book',{project,expectedRevision:revision,draft:{operations:batch.operations},
    preview:{target:{spreads:['first','$chapter'],columns:2},maxEdge:600},inspect:{spread:'first',box:'hero'}});
  assert.equal(overview.image.kind,'contact-sheet');
  assert.deepEqual(overview.image.cells.map(cell=>cell.spread),['first',overview.draft.references.chapter]);
  assert.equal(overview.render.inspection.items[0].id,'hero');
  assert.equal(await readFile(join(folder,'project.json'),'utf8'),before);
  await ready();
  // A draft check renders the unused layout in the real book flow by batch reference, without saving it.
  const draft=await call('check_book',{project,expectedRevision:revision,draft:{operations:batch.operations},preview:{target:{spread:'$chapter'},maxEdge:300}});
  assert.ok(!draft.response.isError,JSON.stringify(draft.data));
  assert.equal(draft.data.state,'ready');
  assert.equal(draft.data.draft.applied,true);
  assert.equal(draft.data.draft.committed,false);
  assert.equal(draft.data.image.draft,true);
  assert.equal(draft.data.image.spread,draft.data.draft.references.chapter);
  const draftImage=draft.response.content.find(c=>c.type==='image');
  assert.equal((await sharp(Buffer.from(draftImage.data,'base64')).metadata()).width,300);
  assert.equal(await readFile(join(folder,'project.json'),'utf8'),before);
  const missingAlias=await call('check_book',{project,expectedRevision:revision,draft:{operations:[{op:'set_title',title:'Draft'}]},preview:{target:{spread:'$chapter'}}});
  assert.equal(missingAlias.data.error.code,'REFERENCE_NOT_FOUND');
  await ready();
  const applied=await good('apply_project_changes',batch);
  assert.equal(applied.committed,true);
  assert.ok(applied.references.chapter);
  await ready();
  assert.equal((await good('apply_project_changes',batch)).replayed,true);
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,2);
  assert.equal((await call('apply_project_changes',{...batch,idempotencyKey:'stale'})).data.error.code,'REVISION_CONFLICT');
  const invalid=await call('apply_project_changes',{...batch,expectedRevision:applied.revision,idempotencyKey:'invalid',operations:[{op:'set_title',title:'Must not save'},{op:'remove_spread',spread:'missing'}]});
  assert.equal(invalid.data.error.code,'SPREAD_NOT_FOUND');
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).title,'MCP book');

  // Agent batch is one UI Undo entry; Redo restores it. UI edits remain in the same history.
  await window.getByRole('button',{name:'Undo',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Edit undone');
  await ready();
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,1);
  await window.getByRole('button',{name:'Redo',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Edit redone');
  await ready();
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,2);

  // Human typing blocks mutations without changing or discarding the draft.
  await window.getByText('Book settings',{exact:true}).click();
  const title=window.getByLabel('Book title');
  await title.fill('Human draft');
  revision=(await good('list_projects')).projects[0].revision;
  const blocked=await call('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'draft-test',label:'Agent title',operations:[{op:'set_title',title:'Agent title'}]});
  assert.equal(blocked.data.error.code,'EDIT_IN_PROGRESS');
  assert.equal(await title.inputValue(),'Human draft');
  await title.blur();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Saved');
  await ready();
  // A UI save that lands while the agent is requesting its lease must not be rejected by agent busy state.
  revision=(await good('list_projects')).projects[0].revision;
  await app.evaluate(({BrowserWindow}) => {
    const contents=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='imageflow://editor/').webContents;
    const send=contents.send;
    globalThis.leaseGate={waiting:false,release:null};
    contents.send=function(channel,...args) {
      if (channel==='project:agent-lease') {
        contents.send=send;
        globalThis.leaseGate.waiting=true;
        globalThis.leaseGate.release=()=>send.call(contents,channel,...args);
        return;
      }
      return send.call(contents,channel,...args);
    };
  });
  const waitingAgent=call('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'lease-race',label:'Agent title',operations:[{op:'set_title',title:'Must not replace human save'}]});
  for (let attempts=0;;attempts++) {
    if (await app.evaluate(()=>globalThis.leaseGate.waiting)) break;
    assert.ok(attempts<100,'agent requested its editing lease');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  await title.fill('Human save during agent handoff');
  await title.blur();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Saved');
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).title,'Human save during agent handoff');
  await app.evaluate(()=>globalThis.leaseGate.release());
  assert.ok(['REVISION_CONFLICT','EDIT_IN_PROGRESS'].includes((await waitingAgent).data.error.code));
  await ready();
  revision=(await good('list_projects')).projects[0].revision;
  const imported=await good('import_sources',{project,expectedRevision:revision,idempotencyKey:'photo-import',kind:'photo',paths:['inbox/green.png']});
  assert.equal(imported.sources.length,1);
  await ready();
  const photo=imported.sources[0].id;
  const assigned=await good('apply_project_changes',{project,expectedRevision:imported.revision,idempotencyKey:'assign-photo',label:'Place photo',operations:[{op:'assign_source',spread:'first',box:'hero',kind:'photo',source:photo}]});
  await ready();
  const spreads=await good('inspect_book',{project,view:'spreads',limit:1});
  assert.equal(spreads.items[0].boxes.hero.photo,photo);
  assert.equal(spreads.nextOffset,1);
  assert.equal(assigned.history.undo,'Place photo');
  const measured=await good('inspect_book',{project,view:'elements',spread:'first',box:'hero'});
  assert.equal(measured.coordinateSpace,'sheet-bleed-mm');
  assert.equal(measured.items[0].source,photo);
  assert.ok(Math.abs(measured.items[0].boundsMm.width-40)<.1);
  const invalidTypes=authored+'\nconst typeMismatch: number = "wrong";\n';
  await writeFile(entry,invalidTypes);
  const typed=await good('check_book',{project,typescript:true,preview:{target:{spread:'first',box:'hero',paddingMm:0},maxEdge:300}});
  assert.equal(typed.checks.typescript,'failed');
  assert.ok(typed.diagnostics.some(d=>d.code==='typescript-error' && d.details.typescriptCode===2322 && d.location.path==='template/index.tsx'));
  assert.equal(typed.image.detail.box,'hero');
  assert.ok(typed.typecheck.files.includes('template/index.tsx'));
  const beforeTypeRestore=await window.locator('iframe.book-frame-book[data-current][data-ready]').getAttribute('src');
  await writeFile(entry,authored);
  await window.waitForFunction(previous=>{
    const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('src')!==previous;
  },beforeTypeRestore);
  await ready();

  // Compiler failure is actionable, preserves the app's last image, and recovers through check_book.
  const shown=await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('src');
  await writeFile(entry,authored+'\nconst broken = ;');
  const broken=await call('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  assert.equal(broken.response.isError,true);
  assert.ok(broken.data.checks,JSON.stringify(broken.data));
  assert.equal(broken.data.checks.bundle,'failed');
  assert.ok(broken.data.diagnostics[0].location.line);
  await window.locator('.status-error').waitFor();
  assert.equal(await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('src'),shown);
  await writeFile(entry,authored);
  await good('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  await ready();

  // A draft can repair a saved book whose layout throws at render time for its current parameter value.
  const chapterLayout='render:ctx=><Spread><h1>{ctx.params.heading}</h1></Spread>}';
  assert.ok(authored.includes(chapterLayout));
  await writeFile(entry,authored.replace(chapterLayout,
    "render:ctx=>{if(ctx.params.heading==='A new chapter') throw new Error('Heading rejected');return <Spread><h1>{ctx.params.heading}</h1></Spread>;}}"));
  await window.locator('.status-error').waitFor();
  const failing=await call('check_book',{project});
  assert.equal(failing.data.state,'error',JSON.stringify(failing.data));
  assert.match(failing.data.revision,/^[a-f0-9]{64}$/);
  const repair={op:'set_parameter',scope:'spread',spread:applied.references.chapter,key:'heading',value:'Recovered'};
  const repaired=await call('check_book',{project,expectedRevision:failing.data.revision,draft:{operations:[repair]},
    preview:{target:{spread:applied.references.chapter},maxEdge:300}});
  assert.ok(!repaired.response.isError,JSON.stringify(repaired.data));
  assert.equal(repaired.data.state,'ready');
  assert.equal(repaired.data.draft.applied,true);
  assert.ok(repaired.response.content.some(c=>c.type==='image'));
  // The settled render failure does not block the agent: the same operations commit, render, and undo in the app.
  const chapterHeading=async()=>JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.find(s=>s.id===applied.references.chapter).params.heading;
  assert.equal(await chapterHeading(),'A new chapter');
  const committedRepair=await good('apply_project_changes',{project,expectedRevision:failing.data.revision,idempotencyKey:'repair-heading',label:'Repair heading',operations:[repair]});
  assert.equal(committedRepair.committed,true);
  assert.equal(await chapterHeading(),'Recovered');
  await window.waitForFunction(()=>!document.querySelector('.status-error'));
  await ready();
  assert.equal((await good('check_book',{project,expectedRevision:committedRepair.revision})).state,'ready');
  await window.getByRole('button',{name:'Undo',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Edit undone');
  assert.equal(await chapterHeading(),'A new chapter');
  await window.getByRole('button',{name:'Redo',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent==='Edit redone');
  assert.equal(await chapterHeading(),'Recovered');
  await ready();
  const beforeRestore=await window.locator('iframe.book-frame-book[data-current][data-ready]').getAttribute('src');
  await writeFile(entry,authored);
  // Let the app adopt the restored template before the next step reads inputs.
  await window.waitForFunction(previous=>{
    const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('src')!==previous;
  },beforeRestore);
  await ready();
  await good('check_book',{project});
  await ready();

  // Broken project JSON must not hide the diagnostics or template sources needed for recovery.
  const savedManifest=await readFile(join(folder,'project.json'),'utf8');
  await writeFile(join(folder,'project.json'),'{ invalid JSON');
  // Inputs that change during a call correctly return SOURCE_CHANGED. Let the app observe this write first.
  await window.locator('.status-error').waitFor();
  for (const name of ['get_authoring_context','inspect_book']) {
    const result=await good(name,{project,...(name==='inspect_book' ? {view:'summary'} : {})});
    assert.ok(result.diagnostics.some(d=>d.message.includes('invalid JSON') && d.location?.path==='project.json'));
    if (name==='get_authoring_context') assert.equal(result.sources['template/index.tsx'].text,authored);
  }
  await writeFile(join(folder,'project.json'),savedManifest);
  await good('check_book',{project});
  await ready();

  // Revocation disconnects the bridge; re-enabling gives it a new token and it reconnects.
  await window.evaluate(()=>window.imageflow.mcpSettings(false));
  await window.getByRole('button', { name: /^Agent ·/ }).waitFor({ state: 'detached' });
  assert.equal((await call('list_projects')).response.isError,true);
  await window.evaluate(()=>window.imageflow.mcpSettings(true));
  await window.getByRole('button', { name: /^Agent ·/ }).waitFor();
  assert.equal((await good('list_projects')).projects[0].project,project);
  const priorFrame=await window.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await menuAction(app, 'Open project…');
  await window.waitForFunction((prior)=>{const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');return frame && frame.getAttribute('src')!==prior;},priorFrame);
  await ready();
  assert.equal((await call('inspect_book',{project,view:'summary'})).data.error.code,'PROJECT_CLOSED');
  await client.close();
  client = undefined;
  const waiting = window.getByRole('button', { name: 'Agent · 0', exact: true });
  await waiting.waitFor();
  const reopened=app.waitForEvent('window');
  await waiting.click();
  const pane=await reopened;
  await pane.getByRole('checkbox', { name: 'Allow agents to use the open book', exact: true }).uncheck();
  await pane.getByText(/^Agents can check, preview and edit/).waitFor();
  await closeSettings(app);
  await window.getByRole('button', { name: /^Agent ·/ }).waitFor({ state: 'detached' });
  console.log('ImageFlow MCP authoring prototype passed.');
} finally {
  await client?.close();
  await app.close();
  await rm(work,{recursive:true,force:true});
}

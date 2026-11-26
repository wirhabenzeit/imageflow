import { packagedMacExecutable } from './mac-paths.mjs';
import { agentSettings, closeApp, closeSettings, menuAction, nextSettings, testBook, undoBook, waitForProject } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const executable = packaged ? packagedMacExecutable(root) : electron;
const work = await mkdtemp(join(root, '.build', 'mcp-smoke-'));
const folder = join(work, 'book.imageflow');
await Promise.all(['template', 'inbox', 'photos'].map((name) => mkdir(join(folder, name), { recursive: true })));
const source = `import { defineTemplate, mm, Spread, PhotoBox, p } from 'imageflow';
const format = (label, w, h) => ({label, trim:{width:mm(w),height:mm(h)},
 bleed:{top:mm(0),bottom:mm(0),outside:mm(0),binding:mm(0)},
 safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
 structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},
 output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}});
export default defineTemplate({id:'mcp-test',version:'1',contract:1,
 formats:{portrait:format('Portrait',80,110),landscape:format('Landscape',110,80)},defaultFormat:'portrait',
 parameters:{color:p.color({label:'Color',default:'#0000ff'}),note:p.string({label:'Note',default:''})},
 spreads:{base:{label:'Base',parameters:{heading:p.string({label:'Heading',default:'Hello'})},
 boxes:{hero:{type:'photo',label:'Photo'}},render:ctx=><Spread><h1 {...ctx.edit('heading')} style={{color:ctx.document.color}}>{ctx.params.heading}</h1>
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
const app = await _electron.launch({executablePath:executable,args:[...(packaged ? [] : [join(root,'.build/desktop')]),'--user-data-dir='+join(work,'profile')],env:{...process.env,IMAGEFLOW_HIDE_WINDOW:'1'}});
let client;
try {
  const window = await testBook(app, folder, false);
  window.setDefaultTimeout(20000);
  await app.evaluate(({dialog}, folder) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]}); },folder);

  const ready = () => window.waitForFunction(()=>document.querySelector('iframe.book-frame-book[data-current][data-ready]') && !document.querySelector('.preview-state'));
  await ready();
  const connectionDialog=await agentSettings(app);
  await connectionDialog.getByRole('checkbox', { name: 'Allow agents to use open books', exact: true }).check();
  await connectionDialog.getByText('Claude Code and other agents').click();
  const configuration=connectionDialog.getByRole('textbox',{name:'MCP connection configuration'});
  await configuration.waitFor();
  const config=JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  // Agents start the bridge with ImageFlow's own executable in Node mode; no separate Node installation.
  assert.equal(config.command,executable);
  assert.deepEqual(config.env,{ELECTRON_RUN_AS_NODE:'1'});
  assert.match(await connectionDialog.getByRole('textbox',{name:'Claude Code command'}).inputValue(),/^claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 imageflow -- /);
  await connectionDialog.getByText('Waiting for an agent to connect.', { exact: true }).waitFor();
  await closeSettings(app);
  await window.getByRole('button', { name: 'No agent connected', exact: true }).waitFor();
  client = new Client({name:'ImageFlow prototype test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({...config,stderr:'pipe'}));
  await window.getByRole('button', { name: /^Connected:/ }).waitFor();
  // The status-bar indicator opens the Agents pane of Settings.
  await window.getByRole('button', { name: /^Connected:/ }).click();
  let agents;
  for (let attempt = 0; attempt < 200; attempt++) {
    agents = app.windows().find((page) => page.url().startsWith('imageflow://editor/settings'));
    if (agents) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(agents, 'The connection indicator opened Settings');
  await agents.getByRole('tab', { name: 'Agents', selected: true }).waitFor();
  await agents.getByText('Connected: ImageFlow prototype test', { exact: true }).waitFor();
  assert.equal((await agents.evaluate(()=>window.imageflow.installMcp('nope'))).error,'Unknown agent.');
  assert.match((await window.evaluate(()=>window.imageflow.installMcp('claude'))).error,/only available to Settings/);
  await closeSettings(app);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['apply_project_changes','check_book','get_authoring_context','import_sources','inspect_book','list_book_checkpoints','list_projects','list_templates','read_library_template','rebuild_dependencies','rename_source','save_template_to_library'].sort());
  // The skill comes with the connection, from the files beside the bridge (outside app.asar in a package).
  assert.ok((await client.listResources()).resources.some(r=>r.uri==='skill://imageflow-templates/SKILL.md'));
  const reference=await client.readResource({uri:'skill://imageflow-templates/references/authoring-workflow.md'});
  assert.match(reference.contents[0].text,/^# Authoring workflow/);
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
  // A call for topics alone looks at nothing of the book, so it does not wait for the calls that do (API-009).
  let slowDone=false;
  const slow=good('check_book',{project}).then(()=>{slowDone=true;});
  const topics=await good('get_authoring_context',{project,docs:['project-commands']});
  assert.equal(slowDone,false,'The topics came before the check that was asked for first');
  assert.ok(topics.docs['project-commands'].includes('replace_source'));
  assert.equal(topics.revision,undefined);
  await slow;
  let context=await good('get_authoring_context',{project});
  assert.equal(context.apiReference,undefined);
  assert.deepEqual(context.sources,{});
  assert.ok(context.topics.some(t=>t.id==='authoring-workflow'));
  const requested=await good('get_authoring_context',{project,docs:['declaration','project-commands'],includeExamples:['minimal'],includeSource:['template/index.tsx']});
  assert.ok(requested.docs.declaration.includes('defineTemplate'));
  assert.ok(requested.docs['project-commands'].includes('"op":"select_format"'));
  assert.ok(requested.examples.find(e=>e.name==='minimal').source.includes('defineTemplate'));
  // A call for topics, examples and sources returns just those (API-001).
  assert.deepEqual(requested.examples.map(e=>e.name),['minimal']);
  assert.equal(requested.template,undefined);
  assert.equal(requested.topics,undefined);
  assert.ok(requested.sources['template/index.tsx'].text.includes('NEW_LAYOUT'));
  // Every tool has a title, a short description, a described argument tree and an output schema.
  for(const tool of tools.tools){
    assert.ok(tool.title && tool.annotations.title===tool.title,tool.name);
    assert.ok(tool.description.length<=400,tool.name);
    assert.equal(tool.outputSchema?.type,'object',tool.name);
  }
  // The template library: list it, save the book's template, and get a conflict instead of a dialog for other files
  // under the same version.
  let library=await good('list_templates');
  assert.ok(library.templates.some(t=>t.source==='built-in'));
  assert.ok(library.templates.every(t=>!('importedFrom' in t)));
  // A built-in template's files, compared with the book's, and one of them read (API-002).
  const starter=await good('read_library_template',{template:'imageflow-starter',project});
  assert.equal(starter.changelog,'CHANGELOG.md');
  assert.ok(starter.files.some(f=>f.path==='index.tsx'&&f.status==='changed'),JSON.stringify(starter.files));
  assert.match((await good('read_library_template',{template:'imageflow-starter',path:'CHANGELOG.md'})).text,/^# Photobook starter/);
  const saved=await good('save_template_to_library',{project});
  assert.equal(saved.status,'saved',JSON.stringify(saved));
  library=await good('list_templates');
  const savedEntry=library.templates.find(t=>t.id==='mcp-test');
  assert.equal(savedEntry?.hash,saved.template.hash);
  assert.equal((await good('save_template_to_library',{project})).status,'unchanged');
  await writeFile(entry,source+'\n// library edit\n');
  const conflict=await good('save_template_to_library',{project});
  assert.equal(conflict.status,'conflict');
  assert.equal(conflict.reason,'changed');
  assert.equal(conflict.current.hash,savedEntry.hash);
  assert.equal((await good('save_template_to_library',{project,replaceHash:savedEntry.hash})).status,'replaced');
  await writeFile(entry,source);
  await ready();
  assert.equal(context.capabilities.typescript,true);
  assert.equal(context.capabilities.contactSheets,true);
  const check=await call('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  assert.ok(!check.response.isError,JSON.stringify(check.data));
  const image=check.response.content.find(c=>c.type==='image');
  assert.equal((await sharp(Buffer.from(image.data,'base64')).metadata()).width,300);
  assert.equal(check.data.image.data,undefined);
  assert.equal(check.data.checks.typescript,'not-run');
  const wrongSide=await call('check_book',{project,preview:{target:{spread:'first',side:'page'},maxEdge:300}});
  assert.equal(wrongSide.response.isError,true);
  assert.ok(wrongSide.data.diagnostics.some(d=>d.code==='preview-target-not-found' && d.message.includes('use left, right or omit side')),JSON.stringify(wrongSide.data));
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
  // The committed batch is in the book history under its key, once.
  const history=await good('list_book_checkpoints',{project,idempotencyKey:batch.idempotencyKey});
  assert.deepEqual(history.checkpoints.map(c=>[c.checkpointId,c.origin,c.mcp.requestFingerprint]),[[applied.checkpointId,'mcp',applied.requestFingerprint]]);
  assert.equal((await call('apply_project_changes',{...batch,idempotencyKey:'stale'})).data.error.code,'REVISION_CONFLICT');
  const invalid=await call('apply_project_changes',{...batch,expectedRevision:applied.revision,idempotencyKey:'invalid',operations:[{op:'set_title',title:'Must not save'},{op:'remove_spread',spread:'missing'}]});
  assert.equal(invalid.data.error.code,'SPREAD_NOT_FOUND');
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).title,'MCP book');

  // Agent batch is one UI Undo entry; Redo restores it. UI edits remain in the same history.
  await undoBook(window, 'undo');
  await ready();
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,1);
  await undoBook(window, 'redo');
  await ready();
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,2);

  // Human typing blocks mutations without changing or discarding the draft.
  if (!await window.locator('.template-controls').getAttribute('open')) await window.locator('.template-controls > summary').click();
  const title=window.getByLabel('Note', {exact:true});
  await title.fill('Human draft');
  revision=(await good('list_projects')).projects[0].revision;
  const blocked=await call('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'draft-test',label:'Agent title',operations:[{op:'set_title',title:'Agent title'}]});
  assert.equal(blocked.data.error.code,'EDIT_IN_PROGRESS');
  assert.equal(blocked.data.error.activeEditor.label,'Note');
  assert.match(blocked.data.error.message,/Note/);
  const editingSummary=await good('inspect_book',{project,view:'summary'});
  assert.deepEqual(editingSummary.activeEditor,blocked.data.error.activeEditor);
  assert.ok(!JSON.stringify(editingSummary).includes('Human draft'));
  const whileEditing=await good('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'draft-validation',label:'Validate title',dryRun:true,operations:[{op:'set_title',title:'Validated title'}]});
  assert.equal(whileEditing.committed,false);
  assert.equal(whileEditing.dryRun,true);
  assert.equal(await title.inputValue(),'Human draft');
  await title.blur();
  await waitForProject(window, (book) => book.project.params.note === 'Human draft');
  await ready();
  assert.equal((await good('inspect_book',{project,view:'summary'})).activeEditor,undefined);

  await window.locator('.spread-thumb[data-spread="first"]').click();
  await window.getByRole('button', { name: 'Edit Heading', exact: true }).click();
  const popover = window.getByRole('dialog', { name: 'Edit Heading', exact: true });
  await popover.waitFor();
  revision=(await good('list_projects')).projects[0].revision;
  const blockedByHeading=await call('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'heading-editor',label:'Agent title',operations:[{op:'set_title',title:'Agent title'}]});
  assert.equal(blockedByHeading.data.error.code,'EDIT_IN_PROGRESS');
  assert.deepEqual(blockedByHeading.data.error.activeEditor,{label:'parameter editor',spread:'first',field:'heading'});
  assert.match(blockedByHeading.data.error.message,/can be saved meanwhile/);
  // The editor keeps only its own spread (#231): a change to another spread saves, and the editor stays open and usable.
  const sameSpread=await call('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'heading-editor-same',label:'Agent heading',
    operations:[{op:'set_parameter',scope:'spread',spread:'first',key:'heading',value:'Agent heading'}]});
  assert.equal(sameSpread.data.error.code,'EDIT_IN_PROGRESS');
  // The user is typing in the editor when the agent saves elsewhere: the editor keeps its focus and draft, and is
  // never paused or covered by a notice on the page (F-042).
  const headingField=popover.getByLabel('Heading',{exact:true});
  await headingField.waitFor();
  await headingField.fill('Typed while the agent saved');
  const elsewhere=await good('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'heading-editor-elsewhere',label:'Agent chapter',
    operations:[{op:'set_parameter',scope:'spread',spread:applied.references.chapter,key:'heading',value:'Saved beside an editor'}]});
  assert.equal(elsewhere.committed,true);
  await ready();
  assert.equal(await popover.isVisible(),true,'The open editor stays open');
  assert.equal(await headingField.evaluate((field)=>document.activeElement===field),true,'The field keeps its focus');
  assert.equal(await headingField.inputValue(),'Typed while the agent saved');
  assert.equal(await headingField.isEditable(),true);
  assert.equal(await window.getByText(/Editing is paused/).count(),0);
  await headingField.pressSequentially(' and after');
  await headingField.fill('Typed after the agent saved');
  // This popover saves when it closes.
  await popover.getByRole('button', { name: 'Close', exact: true }).click();
  await popover.waitFor({state:'detached'});
  await waitForProject(window, (book) => book.project.spreads.find(s=>s.id==='first').params.heading==='Typed after the agent saved');
  const besideEditor=JSON.parse(await readFile(join(folder,'project.json'),'utf8'));
  assert.equal(besideEditor.spreads.find(s=>s.id===applied.references.chapter).params.heading,'Saved beside an editor');
  await ready();
  // The render-failure check below needs the chapter's original heading.
  revision=(await good('list_projects')).projects[0].revision;
  await good('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'heading-editor-restore',label:'Restore chapter',
    operations:[{op:'set_parameter',scope:'spread',spread:applied.references.chapter,key:'heading',value:'A new chapter'}]});
  await ready();

  // A save is not refused while the editor renders the book again after a template edit (F-041). While macOS reports
  // the window as covered, that render can take minutes; here the book view's status is held back to keep it rendering.
  await window.evaluate(() => {
    window.holdRenderStatus = true;
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() {
      const value = data.get.call(this);
      return window.holdRenderStatus && value && typeof value === 'object' && 'state' in value ? { held: true } : value;
    } });
  });
  const current=await readFile(entry,'utf8');
  const shownBefore=await window.evaluate(()=>document.querySelector('iframe.book-frame-book[data-current]')?.dataset.revision);
  await writeFile(entry,current+'\n// reloading\n');
  await window.waitForFunction((shown)=>document.querySelector('.canvas[aria-busy="true"]') &&
    [...document.querySelectorAll('iframe.book-frame-book')].some((frame)=>frame.dataset.revision!==shown),shownBefore);
  revision=(await good('list_projects')).projects[0].revision;
  const duringReload=await good('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'during-reload',label:'Saved during a reload',
    operations:[{op:'set_parameter',scope:'spread',spread:applied.references.chapter,key:'heading',value:'Saved during a reload'}]});
  assert.equal(duringReload.committed,true);
  await window.evaluate(() => { window.holdRenderStatus = false; });
  await ready();
  assert.equal((await window.evaluate(() => window.imageflow.currentProject())).value.project.spreads.find((s)=>s.id===applied.references.chapter).params.heading,'Saved during a reload');
  await writeFile(entry,current);
  await ready();
  revision=(await good('list_projects')).projects[0].revision;
  await good('apply_project_changes',{project,expectedRevision:revision,idempotencyKey:'after-reload-restore',label:'Restore chapter',
    operations:[{op:'set_parameter',scope:'spread',spread:applied.references.chapter,key:'heading',value:'A new chapter'}]});
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
  void waitingAgent.catch(() => {});
  for (let attempts=0;;attempts++) {
    if (await app.evaluate(()=>globalThis.leaseGate.waiting)) break;
    assert.ok(attempts<100,'agent requested its editing lease');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  await title.fill('Human save during agent handoff');
  await title.blur();
  await waitForProject(window, (book) => book.project.params.note === 'Human save during agent handoff');
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).params.note,'Human save during agent handoff');
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
  const beforeTypeRestore=await window.locator('iframe.book-frame-book[data-current][data-ready]').getAttribute('data-revision');
  await writeFile(entry,authored);
  await window.waitForFunction(previous=>{
    const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('data-revision')!==previous;
  },beforeTypeRestore);
  await ready();

  // Compiler failure is actionable, preserves the app's last image, and recovers through check_book.
  const shown=await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('data-revision');
  await writeFile(entry,authored+'\nconst broken = ;');
  const broken=await call('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  assert.equal(broken.response.isError,true);
  assert.ok(broken.data.checks,JSON.stringify(broken.data));
  assert.equal(broken.data.checks.bundle,'failed');
  assert.ok(broken.data.diagnostics[0].location.line);
  await window.locator('.status-error').waitFor();
  assert.equal(await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('data-revision'),shown);
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
  const fixtures=await call('check_book',{project,expectedRevision:failing.data.revision,fixtures:{
    layouts:['chapter'],cases:['typical'],preview:{maxEdge:300,cells:[{layout:'chapter',case:'typical'}]},
  }});
  assert.equal(fixtures.data.state,'error',JSON.stringify(fixtures.data));
  assert.ok(fixtures.data.diagnostics.some(d=>d.code==='layout-render-failed'));
  assert.equal(fixtures.data.checks.fixtures,'completed');
  assert.equal(fixtures.data.image?.fixture,true,JSON.stringify(fixtures.data));
  assert.ok(fixtures.response.content.some(c=>c.type==='image'));
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
  await undoBook(window, 'undo', false);
  assert.equal(await chapterHeading(),'A new chapter');
  await window.locator('.status-error').waitFor();
  await undoBook(window, 'redo');
  assert.equal(await chapterHeading(),'Recovered');
  await ready();
  const beforeRestore=await window.locator('iframe.book-frame-book[data-current][data-ready]').getAttribute('data-revision');
  await writeFile(entry,authored);
  // Let the app adopt the restored template before the next step reads inputs.
  await window.waitForFunction(previous=>{
    const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('data-revision')!==previous;
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
    const result=await good(name,{project,...(name==='inspect_book' ? {view:'summary'} : {includeSource:['template/index.tsx']})});
    assert.ok(result.diagnostics.some(d=>d.message.includes('invalid JSON') && d.location?.path==='project.json'));
    if (name==='get_authoring_context') assert.equal(result.sources['template/index.tsx'].text,authored);
  }
  await writeFile(join(folder,'project.json'),savedManifest);
  await good('check_book',{project});
  await ready();

  // Revocation disconnects the bridge; re-enabling gives it a new token and it reconnects.
  await window.evaluate(()=>window.imageflow.mcpSettings(false));
  await window.getByRole('button', { name: /^(Connected:|No agent connected)/ }).waitFor({ state: 'detached' });
  assert.equal((await call('list_projects')).response.isError,true);
  await window.evaluate(()=>window.imageflow.mcpSettings(true));
  await window.getByRole('button', { name: /^(Connected:|No agent connected)/ }).waitFor();
  assert.equal((await good('list_projects')).projects[0].project,project);
  // Template packages install outside the book (ADR 0006): a local package, bundled into template/vendor/ by
  // rebuild_dependencies, renders, and nothing is installed into the template.
  const local=join(work,'tiny-local');
  await mkdir(local,{recursive:true});
  await writeFile(join(local,'package.json'),JSON.stringify({name:'tiny-local',version:'1.0.0',type:'module',main:'index.js',types:'index.d.ts'}));
  await writeFile(join(local,'index.js'),"export const greeting = 'Packaged hello';\n");
  await writeFile(join(local,'index.d.ts'),'export declare const greeting: string;\n');
  await writeFile(join(folder,'template','package.json'),JSON.stringify({private:true,dependencies:{'tiny-local':'file:'+local}}));
  const plainSource=await readFile(entry,'utf8');
  await writeFile(entry,"import { greeting } from 'tiny-local';\n"+plainSource.replace("default:'Hello'","default:greeting"));
  const rebuilt=await good('rebuild_dependencies',{project});
  assert.equal(rebuilt.state,'ready');
  assert.deepEqual(rebuilt.imports,['tiny-local']);
  assert.ok(JSON.parse(await readFile(join(folder,'template','vendor','manifest.json'),'utf8')).modules['tiny-local']);
  await assert.rejects(stat(join(folder,'template','node_modules')),'nothing is installed into the book');
  await ready();
  const packagedCheck=await good('check_book',{project,typescript:true});
  assert.equal(packagedCheck.state,'ready',JSON.stringify(packagedCheck.diagnostics));
  // The package renders and its vendored declarations resolve (this test template has unrelated type errors of its own).
  assert.ok(!packagedCheck.diagnostics.some(({code,message,details})=>code==='template-compile-error'||details?.typescriptCode===2307||/tiny-local/.test(message)),JSON.stringify(packagedCheck.diagnostics));
  // The menu command runs the same rebuild for people and says what it bundled.
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const owner = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'imageflow://editor/');
    Menu.getApplicationMenu().getMenuItemById('rebuild-dependencies').click(undefined, owner);
  });
  await window.waitForFunction(()=>document.querySelector('.status')?.textContent?.includes('1 import bundled into template/vendor'));
  await writeFile(entry,plainSource);
  await ready();
  const priorFrame=await window.locator('iframe.book-frame-book[data-current]').getAttribute('data-revision');
  await menuAction(app, 'Open project…');
  await ready();
  assert.equal(await window.locator('iframe.book-frame-book[data-current]').getAttribute('data-revision'), priorFrame);
  assert.equal((await good('list_projects')).projects[0].project, project);
  await client.close();
  client = undefined;
  const waiting = window.getByRole('button', { name: 'No agent connected', exact: true });
  await waiting.waitFor();
  const reopened=nextSettings(app);
  await waiting.click();
  const pane=await reopened;
  await pane.getByRole('checkbox', { name: 'Allow agents to use open books', exact: true }).uncheck();
  await pane.getByText(/^Agents select an open book to check, preview and edit/).waitFor();
  await closeSettings(app);
  await window.getByRole('button', { name: /^(Connected:|No agent connected)/ }).waitFor({ state: 'detached' });
  console.log('ImageFlow MCP authoring prototype passed.');
} catch (error) {
  console.error('Agent workflow failed:', error);
  throw error;
} finally {
  await client?.close();
  await closeApp(app);
  await rm(work,{recursive:true,force:true});
}

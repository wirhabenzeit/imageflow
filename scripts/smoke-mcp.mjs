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
  await window.getByRole('button',{name:'Open project…',exact:true}).click();
  const ready = () => window.waitForFunction(()=>document.querySelector('iframe.book-frame-book[data-current][data-ready]') && !document.querySelector('.preview-state'));
  await ready();
  await window.getByRole('button',{name:'Connect an agent…',exact:true}).click();
  const connectionDialog=window.getByRole('dialog',{name:'Connect your agent'});
  await connectionDialog.getByRole('button',{name:'Enable local connection',exact:true}).click();
  const configuration=connectionDialog.getByRole('textbox',{name:'MCP connection configuration'});
  await configuration.waitFor();
  const config=JSON.parse(await configuration.inputValue()).mcpServers.imageflow;
  assert.equal(config.command,'node');
  await connectionDialog.getByRole('button',{name:'Close',exact:true}).click();
  client = new Client({name:'ImageFlow prototype test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({...config,command:process.execPath,stderr:'pipe'}));
  await window.getByRole('button',{name:'Agent connection · 1',exact:true}).waitFor();
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
  let context=await good('get_authoring_context',{project});
  assert.ok(context.apiReference.includes('defineTemplate'));
  assert.ok(context.sources['template/index.tsx'].text.includes('NEW_LAYOUT'));
  assert.equal(context.capabilities.typescript,false);
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

  // Compiler failure is actionable, preserves the app's last image, and recovers through check_book.
  const shown=await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('src');
  await writeFile(entry,authored+'\nconst broken = ;');
  const broken=await call('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  assert.equal(broken.response.isError,true);
  assert.equal(broken.data.checks.bundle,'failed');
  assert.ok(broken.data.diagnostics[0].location.line);
  await window.locator('.status-error').waitFor();
  assert.equal(await window.locator('iframe.book-frame-book[data-ready]').first().getAttribute('src'),shown);
  await writeFile(entry,authored);
  await good('check_book',{project,preview:{target:{spread:'first'},maxEdge:300}});
  await ready();

  // Revocation disconnects the bridge; re-enabling gives it a new token and it reconnects.
  await window.evaluate(()=>window.imageflow.mcpSettings(false));
  assert.equal((await call('list_projects')).response.isError,true);
  await window.evaluate(()=>window.imageflow.mcpSettings(true));
  assert.equal((await good('list_projects')).projects[0].project,project);
  const priorFrame=await window.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await window.getByRole('button',{name:'Open project…',exact:true}).click();
  await window.waitForFunction((prior)=>{const frame=document.querySelector('iframe.book-frame-book[data-current][data-ready]');return frame && frame.getAttribute('src')!==prior;},priorFrame);
  await ready();
  assert.equal((await call('inspect_book',{project,view:'summary'})).data.error.code,'PROJECT_CLOSED');
  console.log('ImageFlow MCP authoring prototype passed.');
} finally {
  await client?.close();
  await app.close();
  await rm(work,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import { closeApp, testBook, undoBook } from './ui-actions.mjs';

// Exercise the advertised schemas, real renderer, atomic saves and shared Undo on an isolated book.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'mcp-pages-'));
const folder = join(work, 'Pages.imageflow');
let app, client;
try {
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), `import { box, defineTemplate, mm, p, Page, printFormat } from 'imageflow';
export default defineTemplate({ id:'mcp-pages',version:'1',contract:1,
 format:printFormat({label:'Pages',trim:{width:mm(100),height:mm(100)},bleed:mm(0),safe:mm(5),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
 spreads:({page})=>({note:page({label:'Note',parameters:{heading:p.string({label:'Heading',default:'Blank'})},
  boxes:{body:box.markdown('Body')},elements:{note:{label:'Note',parameters:{color:p.color({label:'Colour',default:'#ff0000'})}}},
  render:ctx=><Page><ctx.Element id="note" rect={{x:10,y:10,width:20,height:20}} style={{background:ctx.elements.note.params.color}} />
   <ctx.MarkdownBox id="body" rect={{x:10,y:40,width:80,height:50}} /></Page>})})});`);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion:1,title:'Pages',template:{id:'mcp-pages',version:'1'},spreads:[] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  app = await _electron.launch({ executablePath:electron, args:[join(root,'.build/desktop'),'--user-data-dir='+join(work,'profile')],
    env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,IMAGEFLOW_HIDE_WINDOW:'1'} });
  const window = await testBook(app, folder);
  const connection = await window.evaluate(() => window.imageflow.mcpSettings(true));
  client = new Client({name:'Page MCP smoke',version:'1'});
  await client.connect(new StdioClientTransport({...connection.value.launch,stderr:'pipe'}));
  async function call(name,args={}) {
    const response = await client.callTool({name,arguments:args},{timeout:110000});
    const data = response.structuredContent ?? JSON.parse(response.content.find(item=>item.type==='text').text);
    assert.ok(!response.isError, JSON.stringify(data));
    return {data,response};
  }
  const project = (await call('list_projects')).data.projects.find(item=>item.folder===folder).project;
  const context = (await call('get_authoring_context',{project})).data;
  const operations = [{op:'insert_page_pair',ref:'pair',pages:{left:{definition:'note'},right:{definition:'note'}}},
    {op:'set_parameter',spread:'$pair',page:'right',scope:'element',owner:'note',key:'color',value:'#0000ff'}];
  const draft = (await call('check_book',{project,expectedRevision:context.revision,draft:{operations},
    preview:{target:{spread:'$pair',page:'right',element:'note'},maxEdge:100},inspect:{spread:'$pair',page:'right',element:'note'}})).data;
  assert.equal(draft.draft.committed,false);
  assert.equal(draft.render.inspection.items[0].page,'right');
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads.length,0);
  const inserted = (await call('apply_project_changes',{project,expectedRevision:context.revision,idempotencyKey:'pair',label:'Insert pages',operations})).data;
  assert.equal(inserted.committed,true);
  const spread = inserted.references.pair;
  const parameters = (await call('inspect_book',{project,view:'parameters',spread})).data.items[0];
  assert.equal(parameters.declarations,undefined);
  assert.equal(parameters.pageDeclarations.left.label,'Note');
  assert.equal(parameters.pageDeclarations.right.label,'Note');
  for (const [page,expected] of [['left',[255,0,0]],['right',[0,0,255]]]) {
    const result = await call('check_book',{project,preview:{target:{spread,page,element:'note',paddingMm:0},maxEdge:100},
      inspect:{spread,page,element:'note'}});
    assert.equal(result.data.image.side,page);
    assert.equal(result.data.render.inspection.total,1);
    assert.equal(result.data.render.inspection.items[0].page,page);
    const picture = result.response.content.find(item=>item.type==='image');
    const {data,info} = await sharp(Buffer.from(picture.data,'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const at = (Math.floor(info.height/2)*info.width+Math.floor(info.width/2))*info.channels;
    assert.deepEqual([...data.subarray(at,at+3)],expected,'detail preview selects '+page+' page');
    const inspected = (await call('inspect_book',{project,view:'elements',spread,page,element:'note'})).data;
    assert.equal(inspected.items[0].page,page);
  }
  const before = await readFile(join(folder,'project.json'),'utf8');
  const check = (await call('check_book',{project})).data;
  const changed = (await call('apply_project_changes',{project,expectedRevision:check.revision,idempotencyKey:'swap',label:'Swap pages',operations:[{op:'swap_pages',spread}]})).data;
  assert.equal(changed.committed,true);
  assert.equal(JSON.parse(await readFile(join(folder,'project.json'),'utf8')).spreads[0].pages.left.elements.note.params.color,'#0000ff');
  await undoBook(window);
  assert.equal(await readFile(join(folder,'project.json'),'utf8'),before);
  console.log('Page MCP schemas, drafts, declarations, detail images, inspection, save and Undo passed.');
} finally {
  await client?.close();
  if (app) await closeApp(app);
  await rm(work,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction, testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/presentation-startup-'));
const folder = join(work, 'Startup.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await mkdir(join(folder, 'photos'));
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,box,Spread,RenderedImage} from 'imageflow';
export default defineTemplate({id:'startup',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:500,step:2}}),
spreads:{story:{label:'Story',parameters:{index:p.number({label:'Index',default:0})},boxes:{hero:box.photo('Hero')},render:ctx=><Spread>
<ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/>
<RenderedImage label="Slow artwork" inputs={{index:ctx.params.index}} style={{position:'absolute',left:'10mm',top:'10mm',width:'20mm',height:'20mm'}} draw={async target=>{
  if(new URLSearchParams(location.search).get('view')==='present'){
    (window.__startedPictures??=[]).push(ctx.params.index);
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(target.width*target.pixelRatio);canvas.height=Math.ceil(target.height*target.pixelRatio);
  const context=canvas.getContext('2d');context.fillStyle='#cc8844';context.fillRect(0,0,canvas.width,canvas.height);return canvas;
}}/></Spread>}}});`);
const photos = {};
for (const i of [0, 1, 29, 30, 31, 32, 39]) {
  const id = 'p' + i;
  await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#709fb0' } }).jpeg().toFile(join(folder, 'photos', id + '.jpg'));
  photos[id] = { path: 'photos/' + id + '.jpg', title: id };
}
await writeFile(join(folder, 'photos.json'), JSON.stringify(photos));
await writeFile(join(folder, 'project.json'), JSON.stringify({schemaVersion:1,title:'Startup',template:{id:'startup',version:'1'},spreads:
  Array.from({length:40},(_,i)=>({id:'s'+i,definition:'story',params:{index:i},boxes:{hero:{photo:photos['p'+i]?'p'+i:'p0'}}}))}));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: {...process.env, IMAGEFLOW_HIDE_WINDOW:'1'} });
try {
  const page = await testBook(app, folder);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  await page.locator('.spread-thumb[data-spread="s30"]').click();
  const requests = [];
  page.on('request', request => { if(request.url().includes('/proof-photo/')) requests.push(request.url().split('/proof-photo/')[1]); });
  const start = performance.now();
  await menuAction(app, 'Presentation');
  await page.locator('.presentation .book-frame-present[data-current][data-ready]').waitFor();
  const startupMs = Math.round(performance.now() - start);
  const proof = page.frameLocator('.presentation .book-frame-present[data-current][data-ready]');
  const started = await proof.locator('body').evaluate(() => window.__startedPictures ?? []);
  const metrics = { startupMs, startedPictures: started, requestedPhotos: [...requests] };
  console.log(JSON.stringify(metrics));
  if (!process.argv.includes('--measure')) {
    assert.equal(requests[0], 'p30', 'The selected spread is the first original photo requested');
    assert.ok(started.length <= 3 && started.every(index => Math.abs(index - 30) <= 1), 'Only the current spread and neighbours draw artwork at startup');
    const current = proof.locator('.if-present-crop:visible');
    await current.locator('[data-rendered="ready"] img').waitFor();
    assert.equal(await current.locator('img[data-src]').evaluate(image => image.naturalWidth), 1800);
    await page.keyboard.press('ArrowRight');
    await proof.locator('.if-present-crop:visible img[data-src][src$="/p31"]').waitFor();
    await proof.locator('.if-present-crop:visible [data-rendered="ready"]').waitFor();
    await page.keyboard.press('End');
    await proof.locator('.if-present-crop:visible img[data-src][src$="/p39"]').waitFor();
    await proof.locator('.if-present-crop:visible [data-rendered="ready"]').waitFor();
    await page.screenshot({ path: join(work, 'presentation.png') });
    await page.keyboard.press('Escape');
    await page.locator('.presentation').waitFor({ state: 'detached' });
  }
  console.log('Presentation startup checked:', work);
} finally { await app.close(); }

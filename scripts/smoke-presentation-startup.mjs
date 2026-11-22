import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, menuAction, nextPresentation, testBook } from './ui-actions.mjs';
import { buildMacHeaderState, macHeaderState } from './mac-header-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/presentation-startup-'));
const headerHelper = buildMacHeaderState(work);
const folder = join(work, 'Startup.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await mkdir(join(folder, 'photos'));
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,box,Spread,RenderedImage} from 'imageflow';
export default defineTemplate({id:'startup',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:500,step:2}}),
spreads:{shaped:{label:'Shaped photo',boxes:{hero:box.photo('Hero')},render:ctx=><Spread>
<ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}>{(photo,box)=><svg width={photo.box.width} height={photo.box.height}>
<clipPath id={box.uid}><circle cx={photo.box.width/2} cy={photo.box.height/2} r={photo.box.height/3}/></clipPath>
<image href={photo.src} x={photo.image.x} y={photo.image.y} width={photo.image.width} height={photo.image.height} clipPath={'url(#'+box.uid+')'}/>
</svg>}</ctx.PhotoBox></Spread>},story:{label:'Story',parameters:{index:p.number({label:'Index',default:0})},boxes:{hero:box.photo('Hero')},render:ctx=><Spread>
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
for (const i of [0, 1, 15, 29, 30, 31, 32, 39]) {
  const id = 'p' + i;
  await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#709fb0' } }).jpeg().toFile(join(folder, 'photos', id + '.jpg'));
  photos[id] = { path: 'photos/' + id + '.jpg', title: id };
}
await writeFile(join(folder, 'photos.json'), JSON.stringify(photos));
await writeFile(join(folder, 'project.json'), JSON.stringify({schemaVersion:1,title:'Startup',template:{id:'startup',version:'1'},spreads:
  Array.from({length:40},(_,i)=>({id:'s'+i,definition:i===15?'shaped':'story',params:{index:i},boxes:{hero:{photo:photos['p'+i]?'p'+i:'p0'}}}))}));
const visible = process.argv.includes('--visible');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: {...process.env, IMAGEFLOW_HIDE_WINDOW: visible ? '' : '1'} });
try {
  if (!process.argv.includes('--measure')) await app.context().addInitScript(() => {
    if (location.hostname !== 'render' || new URLSearchParams(location.search).get('view') !== 'present') return;
    const decode = HTMLImageElement.prototype.decode;
    let held = false;
    const resize = new MutationObserver(() => {
      if (!document.querySelector('.if-presentation img[data-src]')) return;
      resize.disconnect();
      setTimeout(() => window.dispatchEvent(new Event('resize')), 20);
    });
    resize.observe(document, { childList: true, subtree: true });
    HTMLImageElement.prototype.decode = function () {
      // A detached SVG proxy can load its bytes while Chromium leaves decode() pending in the hidden candidate.
      if (!this.isConnected) {
        window.__heldProxyDecodes = (window.__heldProxyDecodes ?? 0) + 1;
        return new Promise(() => {});
      }
      if (!held && this.matches('img[data-src]') && window.imageflowRenderStatus?.state !== 'ready') {
        held = true;
        // Model a fullscreen resize replacing an image whose first decode never completes. A later draw must
        // be able to report ready independently, rather than keeping the frame hidden behind that old promise.
        return new Promise(() => {});
      }
      return decode.call(this);
    };
  });
  const editor = await testBook(app, folder);
  editor.on('pageerror', error => console.error('Renderer error:', error.message));
  await editor.emulateMedia({ reducedMotion: 'reduce' });
  await editor.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  await editor.locator('.spread-thumb[data-spread="s30"]').click();
  const nativeWindow = await app.browserWindow(editor);
  const originalBounds = await nativeWindow.evaluate((window) => {
    window.__presentationResizes = 0;
    window.on('resize', () => { window.__presentationResizes++; });
    return window.getBounds();
  });
  const originalHeader = headerHelper ? await macHeaderState(nativeWindow, headerHelper) : undefined;
  const checkHeader = async () => {
    assert.deepEqual(await nativeWindow.evaluate((window) => window.getBounds()), originalBounds);
    assert.equal(await nativeWindow.evaluate((window) => window.__presentationResizes), 0, 'Presentation never resizes the editor, including during startup');
    assert.equal(await nativeWindow.evaluate((window) => window.isFullScreen() || window.isSimpleFullScreen()), false);
    if (!headerHelper) return;
    let restored;
    for (let attempt = 0; attempt < 50; ++attempt) {
      restored = await macHeaderState(nativeWindow, headerHelper);
      if (Math.abs(restored.iconX - originalHeader.iconX) <= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.log('Document header:', JSON.stringify({ before: originalHeader, after: restored }));
    assert.ok(originalHeader.iconWidth > 0 && originalHeader.iconX > originalHeader.width / 3, 'The document proxy starts near the window centre');
    assert.ok(Math.abs(restored.iconX - originalHeader.iconX) <= 1, 'The document title and proxy retain their centred position after presentation');
    assert.equal(await nativeWindow.evaluate((window) => window.getTitle()), 'Startup');
    assert.equal(await nativeWindow.evaluate((window) => window.getRepresentedFilename()), folder);
  };
  if (visible) {
    const window = await app.browserWindow(editor);
    await window.evaluate((window) => window.focus());
    await app.evaluate(({ app }) => app.focus({ steal: true }));
  }
  const requests = [];
  app.context().on('request', request => { if(request.url().includes('/proof-photo/')) requests.push(request.url().split('/proof-photo/')[1]); });
  const start = performance.now();
  const opened = nextPresentation(app);
  await editor.keyboard.press('Shift+w');
  const page = await opened;
  await page.waitForURL('imageflow://editor/presentation');
  await page.locator('.presentation .book-frame-present[data-current][data-ready]').waitFor({ timeout: 10000 });
  const startupMs = Math.round(performance.now() - start);
  const proof = page.frameLocator('.presentation .book-frame-present[data-current][data-ready]');
  const started = await proof.locator('body').evaluate(() => window.__startedPictures ?? []);
  const metrics = { startupMs, startedPictures: started, requestedPhotos: [...requests] };
  console.log(JSON.stringify(metrics));
  await checkHeader();
  if (!process.argv.includes('--measure')) {
    assert.equal(await proof.locator('body').evaluate(() => window.__heldProxyDecodes ?? 0), 0, 'Offscreen shaped photos never block startup on decode');
    // The first frame starts on its spread; only a later revision's frame waits to be told the spread on screen.
    assert.equal((await page.locator('.presentation .book-frame-present[data-current]').getAttribute('src')).includes('replacement'), false,
      'The presentation\'s first frame does not wait as a replacement');
    assert.equal(requests.find((source) => !source.startsWith('p15'))?.split('/')[0], 'p30', 'The selected spread is the first ordinary photo requested');
    // Screen-sized, never the camera original, also for the spread on screen (p15 is drawn in an SVG picture).
    assert.ok(requests.filter((source) => !source.startsWith('p15')).every((source) => /\/\d+$/.test(source)), 'The presentation requests sized photos');
    assert.ok(started.length <= 3 && started.every(index => Math.abs(index - 30) <= 1), 'Only the current spread and neighbours draw artwork at startup');
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.presentation')), 'Keyboard focus enters presentation without clicking the slide');
    let window = await app.browserWindow(page);
    if (visible) {
      assert.equal(await window.evaluate((window) => window.isVisible()), true, 'The fullscreen viewer is shown');
      assert.equal(await window.evaluate((window) => window.isFocused()), true, 'The fullscreen viewer receives native keyboard focus');
    }
    let input = page;
    const nativeKey = async (keyCode) => visible ? window.evaluate((window, keyCode) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }, keyCode) : input.keyboard.press({ Right: 'ArrowRight', Left: 'ArrowLeft' }[keyCode] ?? keyCode);
    // --visible exercises the native input path, which requires a focused native window. Neither path clicks
    // the slide or manually focuses it after entry, since that would mask the reported focus failure.
    await nativeKey('Right');
    await proof.locator('.if-present-crop:visible img[data-src][src*="/p31/"]').waitFor({ timeout: 5000 });
    await nativeKey('Left');
    await proof.locator('.if-present-crop:visible img[data-src][src*="/p30/"]').waitFor();
    const current = proof.locator('.if-present-crop:visible');
    await current.locator('[data-rendered="ready"] img').waitFor();
    // A rendition as wide as the screen needs, never wider than the 1800 px original.
    assert.equal(await current.locator('img[data-src]').evaluate(image => image.naturalWidth),
      Math.min(1800, Number((await current.locator('img[data-src]').getAttribute('src')).split('/').pop())));
    await page.keyboard.press('ArrowRight');
    await proof.locator('.if-present-crop:visible img[data-src][src*="/p31/"]').waitFor();
    await proof.locator('.if-present-crop:visible [data-rendered="ready"]').waitFor();
    await page.keyboard.press('End');
    await proof.locator('.if-present-crop:visible img[data-src][src*="/p39/"]').waitFor();
    await proof.locator('.if-present-crop:visible [data-rendered="ready"]').waitFor();
    await page.screenshot({ path: join(work, 'presentation.png') });
    const beforeOverview = requests.length;
    await page.keyboard.press('g');
    await proof.locator('.if-presentation.overview').waitFor();
    const overviewSources = await proof.locator('.if-present-crop img[data-src]').evaluateAll(images => images.map(image => image.getAttribute('src')));
    assert.equal(await proof.locator('.if-present-crop').count(), 40);
    assert.equal(overviewSources.length, 39, 'Overview includes 39 ordinary photos and one SVG photo');
    assert.ok(overviewSources.every(source => /\/proof-photo\/[\w-]+\/\d+$/.test(source)), 'Overview never requests camera originals');
    await proof.locator('.if-present-crop img[data-src]').first().evaluate(image => image.decode());
    assert.ok(await proof.locator('.if-present-crop img[data-src]').evaluateAll(images => images.filter(image => image.complete).every(image => image.naturalWidth <= 1024)));
    assert.ok(requests.slice(beforeOverview).every(source => /\/\d+$/.test(source)));
    await page.keyboard.press('Enter');
    await proof.locator('.if-presentation:not(.overview) .if-present-crop:visible img[data-src][src*="/p39/"]').waitFor();
    await proof.locator('.if-present-crop:visible img[data-src]').evaluate(image => image.decode());
    // Full quality for the screen again: the rendition the spread asks for, never wider than the 1800 px original.
    assert.equal(await proof.locator('.if-present-crop:visible img[data-src]').evaluate(image => image.naturalWidth),
      Math.min(1800, Number((await proof.locator('.if-present-crop:visible img[data-src]').getAttribute('src')).split('/').pop())),
      'Leaving overview restores full photo quality');
    const closed = page.waitForEvent('close');
    await page.keyboard.press('Escape').catch((error) => { if (!page.isClosed()) throw error; });
    await closed;
    await checkHeader();
    const reopened = nextPresentation(app);
    await menuAction(app, 'Presentation');
    input = await reopened;
    await input.waitForURL('imageflow://editor/presentation');
    window = await app.browserWindow(input);
    await input.locator('.presentation .book-frame-present[data-current][data-ready]').waitFor();
    await nativeKey('Home');
    await input.frameLocator('.presentation .book-frame-present[data-current][data-ready]').locator('.if-present-crop:visible img[data-src][src*="/p0/"]').waitFor();
    await input.keyboard.press('3');
    await input.keyboard.press('1');
    await input.keyboard.press('Enter');
    const shaped = input.frameLocator('.book-frame-present[data-current][data-ready]')
      .locator('.if-present-crop:visible [data-photo-render="custom"] svg image');
    await shaped.waitFor();
    assert.match(await shaped.getAttribute('href'), /\/proof-photo\/p15(?:\/\d+)?$/, 'The shaped photo remains available when its spread is shown');
    const closedAgain = input.waitForEvent('close');
    await nativeKey('Escape').catch((error) => { if (!input.isClosed()) throw error; });
    await closedAgain;
    await checkHeader();
    if (process.argv.includes('--repeat')) {
      const timings = [];
      for (let cycle = 0; cycle < 20; ++cycle) {
        const opened = nextPresentation(app);
        const started = performance.now();
        await editor.evaluate((spread) => window.imageflow.startPresentation(spread), cycle % 2 ? 's15' : 's30');
        const repeated = await opened;
        await repeated.waitForURL('imageflow://editor/presentation');
        await repeated.locator('.book-frame-present[data-current][data-ready]').waitFor({ timeout: 5000 });
        timings.push(Math.round(performance.now() - started));
        const closed = repeated.waitForEvent('close', { timeout: 5000 });
        await repeated.keyboard.press('Escape').catch((error) => { if (!repeated.isClosed()) throw error; });
        await closed;
      }
      console.log('20 repeated presentation openings (ms):', JSON.stringify(timings));
      await checkHeader();
    }
  }
  console.log('Presentation startup checked:', work);
} catch (error) {
  for (const page of app.windows().filter(page => ['imageflow://editor/', 'imageflow://editor/presentation'].includes(page.url()))) {
    console.error('Presentation state:', await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 300), presentation: !!document.querySelector('.presentation'), message: document.querySelector('.presentation-message')?.textContent,
      frames: [...document.querySelectorAll('.book-frame-present')].map(frame => ({ src: frame.src, ready: frame.dataset.ready, className: frame.className, height: frame.clientHeight })) })));
    for (const frame of page.frames().filter(frame => frame.url().includes('view=present'))) console.error('Artwork state:', await frame.evaluate(() => ({ state: window.imageflowRenderStatus?.state, ready: document.readyState,
      images: [...document.querySelectorAll('.if-presentation img')].map(image => ({ src: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth })) })));
    await page.screenshot({ path: join(work, 'failed.png') });
  }
  console.error('Failure artifacts:', work);
  throw error;
} finally { await closeApp(app); }

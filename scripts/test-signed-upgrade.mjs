import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { selectUpdate, nativeUpdateURL } from '../src/update-feed.ts';
import { run, verifyMacSigning } from './verify-mac-signing.mjs';
import { readPlan, work } from './upgrade-fixtures.mjs';

if (process.platform !== 'darwin') throw new Error('Real signed upgrades require macOS.');
const plan = await readPlan(), platform = 'darwin-' + process.arch;
const executable = join(plan.installed, 'Contents/MacOS/ImageFlow');
const report = { signed: true, mockInstallation: false, platform, transitions: [], checks: [], startedAt: new Date().toISOString() };
const controller = new AbortController();
const stop = () => controller.abort(new Error('Signed upgrade test cancelled.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const requests = [], releases = new Map(), channelHeads = { stable: null, beta: null };
let offline = false, browser, client, bridgeConfig;
const until = async (operation, message, timeout = 120000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    controller.signal.throwIfAborted();
    try { const value = await operation(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message, { cause: last });
};
const digest = async (file) => {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
};
const json = (response, value) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer({ key: await readFile(join(work, 'tls.key')), cert: await readFile(join(work, 'tls.crt')) }, async (request, response) => {
  try {
    const path = new URL(request.url, plan.baseURL).pathname; requests.push(path);
    if (offline) { response.writeHead(503); response.end(); return; }
    const channel = /^\/updates\/(stable|beta)\/darwin-(arm64|x64)\/RELEASES.json$/.exec(path)?.[1];
    if (channel) { json(response, { schemaVersion: 1, channel, platform, release: channelHeads[channel] }); return; }
    for (const [version, release] of releases) {
      if (path === new URL(nativeUpdateURL(plan.baseURL, platform, version)).pathname) { json(response, release); return; }
      if (path === `/packages/${version}.zip`) {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': release.size });
        const stream = createReadStream(join(work, version + '.zip')); stream.on('error', () => response.destroy()); stream.pipe(response); return;
      }
    }
    response.writeHead(404); response.end();
  } catch (error) { response.destroy(error); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(plan.baseURL).port), '127.0.0.1', resolve); });
const editor = async (expectedVersion, previousSocket) => {
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${plan.debugPort}/json/version`, { signal: AbortSignal.timeout(1000) });
    const info = await response.json();
    return info.webSocketDebuggerUrl && info.webSocketDebuggerUrl !== previousSocket && info;
  }, 'Updated app did not relaunch its debugging endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${plan.debugPort}`);
  const page = await until(() => browser.contexts()[0]?.pages().find((page) => page.url() === 'imageflow://editor/'), 'Book did not reopen after upgrade');
  page.setDefaultTimeout(30000);
  await page.waitForFunction(async (version) => (await window.imageflow?.updateState()).installedVersion === version, expectedVersion);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  return page;
};
const state = (page) => page.evaluate(() => window.imageflow.updateState());
const waitStatus = (page, status) => until(async () => {
  const current = await state(page); if (current.status === 'error') throw new Error(current.message);
  return current.status === status && current;
}, 'Updater did not reach ' + status);
async function reconnect(page) {
  const connection = await page.evaluate(() => window.imageflow.mcpSettings(true));
  assert.ok(connection.value?.enabled, JSON.stringify(connection));
  if (!client) {
    bridgeConfig = connection.value.launch;
    assert.equal(bridgeConfig.command, executable);
    client = new Client({ name: 'Signed upgrade test', version: '1' });
    await client.connect(new StdioClientTransport({ ...bridgeConfig, stderr: 'pipe' }));
  } else assert.deepEqual(connection.value.launch, bridgeConfig, 'MCP launch configuration must survive the upgrade');
  const result = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent.projects.some((project) => project.folder === plan.book));
}
async function upgrade(page, target, channel) {
  await page.evaluate(async (channel) => {
    await window.imageflow.updateSettings({ automaticUpdates: false, updateChannel: channel });
    await window.imageflow.checkUpdates();
  }, channel);
  await waitStatus(page, 'ready');
  assert.ok(requests.includes(`/packages/${target}.zip`), 'The actual update ZIP must be downloaded');
  const beforeLock = JSON.parse(await readFile(join(plan.book, '.imageflow/writer.lock'), 'utf8'));
  const info = await fetch(`http://127.0.0.1:${plan.debugPort}/json/version`).then((r) => r.json());
  const from = (await state(page)).installedVersion;
  // Calls the real app quit path and real Squirrel quitAndInstall; neither is replaced or intercepted.
  await page.evaluate(() => window.imageflow.restartUpdate()).catch((error) => { if (!/closed|destroyed/i.test(error.message)) throw error; });
  await until(() => !browser.isConnected(), 'Old application connection did not close');
  const next = await editor(target, info.webSocketDebuggerUrl);
  assert.equal((await next.evaluate(() => window.imageflow.currentProject())).value.project.spreads[0].params.heading, 'Kept through signed upgrades');
  const afterLock = JSON.parse(await readFile(join(plan.book, '.imageflow/writer.lock'), 'utf8'));
  assert.notDeepEqual(afterLock, beforeLock, 'The new process must reacquire its own book lock');
  await verifyMacSigning(plan.installed);
  await reconnect(next);
  await next.evaluate(() => window.imageflow.updateSettings({ automaticUpdates: false }));
  report.transitions.push({ from, to: target, channel, savedBook: true, lockReacquired: true, mcpReconnected: true });
  await writeFile(join(work, 'signed-upgrade-report.json'), JSON.stringify(report, null, 2));
  console.log(`Real signed upgrade passed: ${from} → ${target} (${channel})`);
  return next;
}
try {
  await mkdir(join(work, 'Applications'), { recursive: true });
  for (const [index, version] of plan.versions.entries()) {
    const app = join(work, String(index), `ImageFlow-darwin-${process.arch}`, 'ImageFlow.app');
    await verifyMacSigning(app);
    const file = join(work, version + '.zip');
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, file]);
    releases.set(version, { version, url: new URL(`/packages/${version}.zip`, plan.baseURL).href,
      name: version, notes: 'Isolated signed upgrade test', pub_date: new Date().toISOString(), sha256: await digest(file), size: (await stat(file)).size });
  }
  await run('ditto', [join(work, '0', `ImageFlow-darwin-${process.arch}`, 'ImageFlow.app'), plan.installed]);
  const child = spawn(executable, [], { env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, stdio: 'inherit' });
  child.once('error', (error) => { console.error(error); });
  let page = await editor(plan.versions[0]);
  await waitStatus(page, 'current');
  await page.evaluate(() => window.imageflow.updateSettings({ automaticUpdates: false }));
  const heading = page.getByRole('textbox', { name: 'Heading', exact: true });
  await heading.fill('Kept through signed upgrades'); await heading.blur();
  await page.waitForFunction(async () => (await window.imageflow.currentProject()).value.project.spreads[0].params.heading === 'Kept through signed upgrades');
  await reconnect(page);
  channelHeads.beta = releases.get(plan.versions[1]);
  await page.evaluate(async () => { await window.imageflow.updateSettings({ updateChannel: 'stable' }); await window.imageflow.checkUpdates(); });
  await waitStatus(page, 'current');
  assert.equal(requests.some((path) => path.startsWith('/packages/')), false, 'Stable must never download a beta');
  report.checks.push('stable excludes beta');
  offline = true;
  await page.evaluate(() => window.imageflow.checkUpdates());
  await until(async () => (await state(page)).status === 'error', 'Offline feed did not report an error');
  offline = false;
  report.checks.push('offline feed error');
  page = await upgrade(page, plan.versions[1], 'beta');
  channelHeads.stable = channelHeads.beta = releases.get(plan.versions[2]);
  page = await upgrade(page, plan.versions[2], 'beta');
  channelHeads.stable = channelHeads.beta = releases.get(plan.versions[3]);
  page = await upgrade(page, plan.versions[3], 'stable');
  await page.evaluate(() => window.imageflow.checkUpdates()); await waitStatus(page, 'current');
  channelHeads.stable = releases.get(plan.versions[2]);
  assert.equal(selectUpdate({ schemaVersion: 1, channel: 'stable', platform, release: channelHeads.stable }, 'stable', platform, plan.versions[3]), null);
  await page.evaluate(() => window.imageflow.checkUpdates()); await waitStatus(page, 'current');
  report.checks.push('up to date', 'no downgrade');
  report.completedAt = new Date().toISOString(); report.passed = true;
  await writeFile(join(work, 'signed-upgrade-report.json'), JSON.stringify(report, null, 2));
  const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {});
} catch (error) {
  report.passed = false; report.error = error.stack; report.cause = error.cause?.stack ?? String(error.cause ?? '');
  await writeFile(join(work, 'signed-upgrade-report.json'), JSON.stringify(report, null, 2)); throw error;
} finally {
  await client?.close().catch(() => {});
  // Only processes launched from this isolated fixture path are eligible for cleanup.
  const pattern = '^' + executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)';
  await run('pkill', ['-f', pattern]).catch((error) => { if (error.code !== 1) console.error(error); });
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}

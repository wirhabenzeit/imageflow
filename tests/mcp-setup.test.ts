import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { addToCodex, bridgeLaunch, claudeCodeCommand, claudeExtension, findCodex, skillArchive } from '../desktop/mcp-setup';
import { mcpTools } from '../src/mcp-contract';

const launch = bridgeLaunch('/Applications/Image Flow.app/Contents/MacOS/ImageFlow', '/Applications/Image Flow.app/Contents/Resources/app.asar.unpacked/mcp-bridge.cjs', "/Users/me/Library/Application Support/ImageFlow/mcp-connection.json");

test('the bridge launches through the app executable in Node mode', () => {
  assert.deepEqual(launch.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(launch.args.slice(1), ['--connection', '/Users/me/Library/Application Support/ImageFlow/mcp-connection.json']);
  assert.equal(claudeCodeCommand(launch),
    "claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 imageflow -- '/Applications/Image Flow.app/Contents/MacOS/ImageFlow' " +
    "'/Applications/Image Flow.app/Contents/Resources/app.asar.unpacked/mcp-bridge.cjs' --connection '/Users/me/Library/Application Support/ImageFlow/mcp-connection.json'");
});

test('the Claude Desktop extension is a valid archive whose launcher starts the app bridge', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-mcpb-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'ImageFlow.mcpb');
  const icon = await readFile(join(process.cwd(), 'resources', 'extension-icon.png'));
  await writeFile(file, claudeExtension({ launch, version: '1.2.3', tools: mcpTools, icon }));
  execFileSync('unzip', ['-tq', file]);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' }));
  assert.equal(manifest.manifest_version, '0.2');
  assert.equal(manifest.icon, 'icon.png');
  assert.deepEqual(execFileSync('unzip', ['-p', file, 'icon.png']), icon);
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.server.type, 'binary');
  assert.equal(manifest.server.entry_point, 'server/imageflow-mcp.sh');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/imageflow-mcp.sh', launch.command, ...launch.args]);
  assert.deepEqual(manifest.tools.map((tool: { name: string }) => tool.name), mcpTools.map((tool) => tool.name));
  assert.match(execFileSync('unzip', ['-Z', file, 'server/imageflow-mcp.sh'], { encoding: 'utf8' }), /^-rwxr-xr-x/);

  execFileSync('unzip', ['-q', file, '-d', join(folder, 'extension')]);
  const script = join(folder, 'extension/server/imageflow-mcp.sh');
  const env = { PATH: process.env.PATH };
  const started = spawnSync('/bin/sh', [script, '/usr/bin/printenv', 'ELECTRON_RUN_AS_NODE'], { encoding: 'utf8', env });
  assert.equal(started.stdout.trim(), '1');
  const moved = spawnSync('/bin/sh', [script, '/missing/ImageFlow', 'bridge.cjs'], { encoding: 'utf8', env });
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /no longer at \/missing\/ImageFlow/);
});

test('ChatGPT and Codex registration runs codex mcp add with the launch configuration', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-codex-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const codex = join(folder, 'codex');
  const log = join(folder, 'args.json');
  await writeFile(codex, `#!/usr/bin/env node\nif (process.argv[2] !== '--version') require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(codex, 0o755);
  assert.equal(await findCodex([join(folder, 'missing'), codex]), codex);
  await addToCodex(codex, launch);
  assert.deepEqual(JSON.parse(await readFile(log, 'utf8')),
    ['mcp', 'add', 'imageflow', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', launch.command, ...launch.args]);
});

test('the template skill archive holds the skill folder with its references and examples', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-skill-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'imageflow-templates.zip');
  await writeFile(file, await skillArchive(resolve('skills/imageflow-templates')));
  execFileSync('unzip', ['-tq', file]);
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(names.includes('imageflow-templates/SKILL.md'));
  assert.ok(names.includes('imageflow-templates/references/authoring-workflow.md'));
  assert.ok(names.includes('imageflow-templates/examples/minimal.tsx'));
  assert.ok(names.every((name) => name.startsWith('imageflow-templates/')));
  await assert.rejects(skillArchive(folder), /missing/);
});

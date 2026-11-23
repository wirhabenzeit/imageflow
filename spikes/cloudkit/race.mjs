// Question 4: two processes create the same record name at the same moment; exactly one must succeed.
//   node race.mjs [variant] [rounds]
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [variant = 'dev', rounds = '10'] = process.argv.slice(2);
const exe = join(fileURLToPath(new URL('./', import.meta.url)), 'out', variant, 'ImageFlow CloudKit Spike-darwin-arm64', 'ImageFlow CloudKit Spike.app', 'Contents', 'MacOS', 'CloudKitSpike');
const zone = 'spike-race-' + Date.now().toString(36);

async function side(options) {
  const { stdout } = await run(exe, ['race', JSON.stringify(options)], { maxBuffer: 1 << 24 }).catch((error) => error);
  return JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1));
}

const results = [];
for (let round = 0; round < Number(rounds); round++) {
  const at = Date.now() + 6000;
  const [a, b] = await Promise.all(['A', 'B'].map((label) => side({ zone, name: 'snapshots/race-' + round + '.json', at, label })));
  const created = [a, b].filter((side) => side.result && !side.result.existed).map((side) => side.result.label);
  const winners = new Set([a, b].map((side) => side.result?.winner));
  const ok = created.length === 1 && winners.size === 1 && winners.has(created[0]);
  results.push({ round, created, winners: [...winners], startSkewMs: Math.abs((a.result?.started ?? 0) - (b.result?.started ?? 0)), ok, errors: [a, b].filter((side) => side.error) });
  console.log(JSON.stringify(results.at(-1)));
}
await run(exe, ['cleanup']);
console.log(JSON.stringify({ rounds: results.length, allOk: results.every((r) => r.ok) }));

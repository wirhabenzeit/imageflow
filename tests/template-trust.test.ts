import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TemplateTrust, trustedOrigins } from '../desktop/template-trust';

// Lasting network trust in a library template version (ADR 0006): bound to the template's hash, kept across launches.
const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);

test('allowed sites are kept per template hash, survive a restart and can be revoked', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-trust-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'template-trust.json');
  const trust = new TemplateTrust(file);
  assert.deepEqual(await trust.allowed(hash), []);
  await trust.allow(hash, ['https://tiles.example.com', 'https://a.example.com', 'https://a.example.com'], { id: 'maps', version: '1.0.0' });
  assert.deepEqual(await trust.allowed(hash), ['https://a.example.com', 'https://tiles.example.com']);
  assert.deepEqual(await trust.allowed(other), [], 'another version of the template is not trusted');
  const restarted = new TemplateTrust(file);
  assert.deepEqual(await restarted.allowed(hash), ['https://a.example.com', 'https://tiles.example.com']);
  await restarted.revoke(hash);
  assert.deepEqual(await new TemplateTrust(file).allowed(hash), []);
  await assert.rejects(trust.allow('not-a-hash', [], { id: 'x', version: '1' }), /Unknown template version/);
});

test('a damaged trust file trusts nothing', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-trust-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'template-trust.json');
  await writeFile(file, '{ not json');
  assert.deepEqual(await new TemplateTrust(file).allowed(hash), []);
  await writeFile(file, JSON.stringify({ schema: 1, templates: { [hash]: { origins: 'https://x.example.com' }, short: { origins: [] } } }));
  assert.deepEqual(await new TemplateTrust(file).allowed(hash), []);
  const trust = new TemplateTrust(file);
  await trust.allow(other, ['https://x.example.com'], { id: 'maps', version: '2' });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).templates), [other]);
});

test('built-in templates are trusted for all they declare; others only for what was allowed', () => {
  const declared = ['https://tiles.example.com', 'https://fonts.example.com'];
  assert.deepEqual(trustedOrigins(declared, { builtIn: true, allowed: [] }), declared);
  assert.deepEqual(trustedOrigins(declared, { builtIn: false, allowed: ['https://fonts.example.com', 'https://other.example.com'] }), ['https://fonts.example.com']);
  assert.deepEqual(trustedOrigins(declared, { builtIn: false, allowed: [] }), []);
});

test('a built-in template is remembered by hash, so its books stay trusted after an update changes it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-trust-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'template-trust.json');
  const trust = new TemplateTrust(file);
  await trust.rememberBuiltIn(hash, ['https://tiles.example.com'], { id: 'imageflow-starter', version: '0.3.0' });
  const written = await readFile(file, 'utf8');
  assert.equal(JSON.parse(written).templates[hash].builtIn, true);
  // The next launch ships another starter; the old hash is no longer a built-in but is still trusted.
  const updated = new TemplateTrust(file);
  assert.deepEqual(await updated.allowed(hash), ['https://tiles.example.com']);
  assert.deepEqual(trustedOrigins(['https://tiles.example.com'], { builtIn: false, allowed: await updated.allowed(hash) }), ['https://tiles.example.com']);
  // Remembering it again writes nothing; a site the built-in adds is merged in.
  await updated.rememberBuiltIn(hash, ['https://tiles.example.com'], { id: 'imageflow-starter', version: '0.3.0' });
  assert.equal(await readFile(file, 'utf8'), written);
  await updated.rememberBuiltIn(hash, ['https://fonts.example.com'], { id: 'imageflow-starter', version: '0.3.0' });
  assert.deepEqual(await new TemplateTrust(file).allowed(hash), ['https://fonts.example.com', 'https://tiles.example.com']);
  // Templates without sites, and malformed hashes, are not recorded.
  await updated.rememberBuiltIn(other, [], { id: 'whitewall', version: '1.0.0' });
  await updated.rememberBuiltIn('not-a-hash', ['https://x.example.com'], { id: 'x', version: '1' });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).templates), [hash]);
});

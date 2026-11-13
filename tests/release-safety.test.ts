import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const script = (name: string) => pathToFileURL(resolve('scripts', name + '.mjs')).href;
function check(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { generateKeyPairSync } from 'node:crypto';
    import { validateReleaseSecrets } from ${JSON.stringify(script('release-secrets'))};
    import { findRelease, publishDraft } from ${JSON.stringify(script('release-draft'))};
    import { retryBookRefresh } from ${JSON.stringify(script('ui-actions'))};
    import { verifyReleaseMain } from ${JSON.stringify(script('release-main'))};
    import { withMacCredentials } from ${JSON.stringify(script('mac-credentials'))};
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const secrets = {
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM)', APPLE_CERTIFICATE_PASSWORD: 'test-password',
      APPLE_CERTIFICATE_P12_BASE64: Buffer.from('test certificate').toString('base64'),
      APPLE_API_KEY_BASE64: Buffer.from(key).toString('base64'), APPLE_API_KEY_ID: 'EXAMPLE123', APPLE_API_ISSUER: 'test-issuer',
    };
    ${source}
  `], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
}

test('release preflight rejects empty or invalid API keys before any file or build operation', () => check(`
  validateReleaseSecrets(secrets);
  for (const value of [undefined, '', String.fromCharCode(32, 10, 32)]) {
    assert.throws(() => validateReleaseSecrets({ ...secrets, APPLE_API_KEY_BASE64: value }), /APPLE_API_KEY_BASE64 is required and must not be empty/);
  }
  assert.throws(() => validateReleaseSecrets({ ...secrets, APPLE_API_KEY_BASE64: '%%%%' }), /APPLE_API_KEY_BASE64 must contain valid base64/);
  assert.throws(() => validateReleaseSecrets({ ...secrets, APPLE_API_KEY_BASE64: Buffer.from('invalid PEM').toString('base64') }), /must decode to a valid P-256 private key/);
`));

test('transient source retries depend on codes and remain bounded when wording changes', () => check(`
  let calls = 0, waits = 0;
  const result = await retryBookRefresh(async () => {
    calls++;
    if (calls === 1) return { code: 'BOOK_BUSY', error: 'Completely different wording' };
    if (calls === 2) return { value: { diagnostics: [{ code: 'source-changed' }] } };
    return { value: { diagnostics: [{ code: 'source-unavailable' }] } };
  }, async () => { waits++; }, { delay: 0 });
  assert.equal(calls, 3); assert.equal(waits, 2);
  assert.equal(result.value.diagnostics[0].code, 'source-unavailable');
  calls = 0;
  await retryBookRefresh(async () => { calls++; return { error: 'ImageFlow is finishing another operation in this book.' }; }, async () => {}, { delay: 0 });
  assert.equal(calls, 1, 'Message text alone must never trigger retry');
  calls = 0;
  const busy = await retryBookRefresh(async () => { calls++; return { code: 'BOOK_BUSY', error: 'Busy' }; }, async () => {}, { attempts: 2, delay: 0 });
  assert.equal(calls, 2); assert.equal(busy.code, 'BOOK_BUSY');
`));

test('release lookup errors, partial pagination and duplicate drafts never trigger creation', () => check(`
  let commands = 0;
  const execute = async () => { commands++; throw new Error('Unexpected write'); };
  const options = { tag: 'v1.2.3', prerelease: false, files: ['one.zip', 'two.dmg'] };
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishDraft(options, async () => ({ status }), execute), new RegExp('Release lookup failed with HTTP ' + status));
  }
  await assert.rejects(publishDraft(options, async () => { throw new Error('Network timeout'); }, execute), /Network timeout/);
  await assert.rejects(publishDraft(options, async () => ({ status: 200, body: null }), execute), /Invalid release-lookup response/);
  await assert.rejects(publishDraft(options, async path => path.includes('/tags/') ? { status: 404 } : { status: 503 }, execute), /Draft lookup failed with HTTP 503/);
  await assert.rejects(publishDraft(options, async path => {
    if (path.includes('/tags/')) return { status: 404 };
    if (path.endsWith('page=1')) return { status: 200, body: Array.from({ length: 100 }, () => ({ tag_name: 'other' })) };
    return { status: 500 };
  }, execute), /Draft lookup failed with HTTP 500/);
  await assert.rejects(publishDraft(options, async path => path.includes('/tags/') ? { status: 404 } : { status: 200, body: [{ tag_name: 'v1.2.3', draft: true }, { tag_name: 'v1.2.3', draft: true }] }, execute), /Multiple releases already use/);
  assert.equal(commands, 0);
`));

test('only confirmed absence creates a draft; an existing draft is reused and published releases are rejected', () => check(`
  const options = { tag: 'v1.2.3-test.1', prerelease: true, files: ['one.zip', 'two.dmg'] };
  for (const existing of [false, true]) {
    const calls = [];
    const request = async path => path.includes('/tags/') ? { status: 404 } : { status: 200, body: existing ? [{ tag_name: options.tag, draft: true }] : [] };
    const execute = async (command, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ isDraft: true, url: 'https://example.invalid/draft', assets: [{ name: 'one.zip' }, { name: 'two.dmg' }] }) };
    };
    await publishDraft(options, request, execute);
    assert.equal(calls[0][1], existing ? 'upload' : 'create');
    if (!existing) for (const flag of ['--draft', '--verify-tag', '--generate-notes', '--prerelease']) assert.ok(calls[0].includes(flag));
  }
  await assert.rejects(publishDraft(options, async () => ({ status: 200, body: { tag_name: options.tag, draft: false } }), async () => { throw new Error('Unexpected write'); }), /Refusing to modify a published release/);
`));

test('release ancestry rejects unmerged commits and accepts commits merged onto origin/main', () => check(`
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-main-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
  const commit = message => git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '--allow-empty', '-m', message);
  try {
    git('init', '-b', 'main'); commit('Main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await verifyReleaseMain(folder);
    git('switch', '-c', 'unmerged'); commit('Unmerged');
    await assert.rejects(verifyReleaseMain(folder), /Tagged commit must be on origin\\/main/);
    git('switch', 'main'); git('merge', '--ff-only', 'unmerged');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await verifyReleaseMain(folder);
  } finally { await rm(folder, { recursive: true, force: true }); }
`));

test('signing credentials exist only inside their operation and API key files exist only for notarization', () => check(`
  const { mkdtemp, writeFile, readFile, access, readdir, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  for (const [mode, failRestore] of [['sign', false], ['notarize', false], ['notarize', true]]) {
    const folder = await mkdtemp(join(tmpdir(), 'imageflow-credential-test-'));
    const previous = ['/example/Work Space.keychain-db', '/example/System.keychain'];
    let list = [...previous], database;
    const execute = async (command, args) => {
      assert.equal(command, 'security');
      if (args[0] === 'list-keychains') {
        if (args.includes('-s')) {
          const next = args.slice(args.indexOf('-s') + 1);
          if (failRestore && database && !next.includes(database)) throw new Error('Restore failed: ' + secrets.APPLE_CERTIFICATE_PASSWORD);
          list = next;
        }
        return { stdout: list.map(path => '    ' + JSON.stringify(path)).join('\\n') };
      }
      if (args[0] === 'create-keychain') { database = args.at(-1); await writeFile(database, 'test db'); }
      if (args[0] === 'import') await access(args[1]);
      if (args[0] === 'delete-keychain') await rm(args[1]);
      return { stdout: '', stderr: '' };
    };
    try {
      await withMacCredentials({ mode, env: secrets, temporary: folder, execute }, async env => {
        assert.equal(env.APPLE_CERTIFICATE_PASSWORD, undefined);
        assert.equal(env.APPLE_CERTIFICATE_P12_BASE64, undefined);
        assert.equal(env.APPLE_API_KEY_BASE64, undefined);
        await access(env.APPLE_SIGNING_KEYCHAIN);
        await assert.rejects(access(join(dirname(database), 'identity.p12')), { code: 'ENOENT' });
        if (mode === 'notarize') {
          assert.equal(await readFile(env.APPLE_API_KEY, 'utf8'), key);
          assert.equal((await stat(env.APPLE_API_KEY)).mode & 0o077, 0);
        } else assert.equal(env.APPLE_API_KEY, undefined);
        throw new Error('Test operation failed');
      }).then(() => assert.fail('Expected failure'), error => {
        assert.match(error.message, failRestore ? /Could not fully clean up temporary signing credentials/ : /Test operation failed/);
        assert.ok(!String(error.errors).includes(secrets.APPLE_CERTIFICATE_PASSWORD), 'Cleanup errors must not expose credential values');
      });
      if (!failRestore) assert.deepEqual(list, previous);
      assert.deepEqual(await readdir(folder), []);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
`));

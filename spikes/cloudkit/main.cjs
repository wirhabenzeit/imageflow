// Electron main process for the CloudKit spike. Runs one measurement task and quits:
//   <app>/Contents/MacOS/<exe> <task> [options as JSON]
// Each task prints JSON lines on stdout, the last one { done: true, ... } or { error }.
const { app } = require('electron');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CloudKitStore, native } = require('./store.cjs');

const [task = 'status', rawOptions = '{}'] = process.argv.slice(process.defaultApp ? 2 : 1).filter((arg) => !arg.startsWith('-'));
const options = JSON.parse(rawOptions);
const log = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const retries = [];
const store = new CloudKitStore({ onRetry: (error, seconds) => { retries.push({ code: error.code, seconds }); log({ retry: error.code, seconds }); } });
const now = () => performance.now();
const mb = (bytes) => bytes / 1024 / 1024;

async function randomFile(directory, megabytes) {
  const file = join(directory, randomUUID());
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  for (let written = 0; written < megabytes; written++) {
    const chunk = randomBytes(1024 * 1024);
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return { file, sha256: hash.digest('hex'), size: megabytes * 1024 * 1024 };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function zoneName(prefix) { return 'spike-' + prefix + '-' + Date.now().toString(36); }

const tasks = {
  async status() {
    return native.status();
  },

  // A small conformance run of the store operations.
  async smoke() {
    const status = await store.status();
    log({ status });
    const book = zoneName('smoke');
    const directory = await mkdtemp(join(tmpdir(), 'ck-'));
    const checks = {};
    try {
      const small = new TextEncoder().encode('{"hello":"cloudkit"}');
      checks.putNew = (await store.putIfAbsent('books/' + book + '/snapshots/a.json', small)).existed === false;
      checks.putExisting = (await store.putIfAbsent('books/' + book + '/snapshots/a.json', new TextEncoder().encode('other'))).existed === true;
      checks.getKeepsFirst = new TextDecoder().decode(await store.get('books/' + book + '/snapshots/a.json')) === '{"hello":"cloudkit"}';
      checks.getMissing = (await store.get('books/' + book + '/snapshots/missing.json')) === undefined;
      checks.getMissingZone = (await store.get('books/no-such-zone-' + Date.now() + '/x')) === undefined;
      const head = await store.head('books/' + book + '/snapshots/a.json');
      checks.head = head?.size === small.length && head.lastModified instanceof Date && Date.now() - head.lastModified < 120_000;
      const large = await randomFile(directory, 3);
      checks.putFile = (await store.putIfAbsent('books/' + book + '/originals/' + large.sha256 + '.jpg', { file: large.file }, { sha256: large.sha256 })).existed === false;
      const target = join(directory, 'download');
      checks.download = await store.download('books/' + book + '/originals/' + large.sha256 + '.jpg', target) && await sha256(target) === large.sha256;
      checks.downloadMissing = (await store.download('books/' + book + '/originals/nothing.jpg', join(directory, 'none'))) === false;
      const inlineBig = randomBytes(400 * 1024); // above the inline limit: goes as an asset from bytes
      await store.putIfAbsent('books/' + book + '/content/big', inlineBig);
      checks.getAssetBytes = Buffer.from(await store.get('books/' + book + '/content/big')).equals(inlineBig);
      const listed = await store.list('books/' + book + '/');
      checks.list = listed.map((item) => item.key.split('/').slice(2).join('/')).join(',') === ['content/big', 'originals/' + large.sha256 + '.jpg', 'snapshots/a.json'].join(',');
      checks.listSizes = listed.every((item) => item.size > 0 && item.lastModified instanceof Date);
      checks.listSnapshotsOnly = (await store.list('books/' + book + '/snapshots/')).length === 1;
      checks.listPrefixes = (await store.listPrefixes('books/')).includes('books/' + book + '/');
      await store.putIfAbsent('remote.json', new TextEncoder().encode(JSON.stringify({ version: 1, remoteId: randomUUID() })));
      checks.indexZone = (await store.list('remote')).some((item) => item.key === 'remote.json');
      await store.putIfAbsent('books/' + book + '/deleted.json', new TextEncoder().encode('{}'));
      checks.tombstoneInIndex = (await store.list('books/' + book + '/deleted')).length === 0 && !!(await store.head('books/' + book + '/deleted.json'));
      // Abort a running upload.
      const abortable = await randomFile(directory, 30);
      const controller = new AbortController();
      const started = store.putIfAbsent('books/' + book + '/originals/abort.jpg', { file: abortable.file }, { signal: controller.signal, onProgress: (p) => { if (p > 0.1) controller.abort(); } });
      setTimeout(() => controller.abort(), 3000);
      checks.abort = await started.then(() => false, (error) => error.code === 'operationCancelled');
      checks.abortLeftNothing = (await store.head('books/' + book + '/originals/abort.jpg')) === undefined;
      await store.delete(['books/' + book + '/snapshots/a.json', 'books/' + book + '/snapshots/missing.json']);
      checks.delete = (await store.head('books/' + book + '/snapshots/a.json')) === undefined;
      await store.delete(['books/' + book + '/deleted.json', 'remote.json']);
    } finally {
      await store.deleteBook(book);
      await rm(directory, { recursive: true, force: true });
    }
    checks.deleteBook = !(await store.listPrefixes('books/')).includes('books/' + book + '/');
    return { checks, passed: Object.values(checks).every(Boolean) };
  },

  // Round-trips files of the given sizes (MB) one after another.
  async sizes({ sizes = [20, 50, 100], keep = false } = {}) {
    const book = zoneName('sizes');
    const directory = await mkdtemp(join(tmpdir(), 'ck-'));
    const results = [];
    try {
      for (const size of sizes) {
        const blob = await randomFile(directory, size);
        const key = 'books/' + book + '/originals/' + blob.sha256 + '.bin';
        let lastProgress = 0;
        const started = now();
        try {
          await store.putIfAbsent(key, { file: blob.file }, { sha256: blob.sha256, onProgress: (p) => { if (p - lastProgress >= 0.25) { lastProgress = p; log({ size, upload: Math.round(p * 100) }); } } });
          const uploaded = now();
          const target = join(directory, 'down-' + size);
          await store.download(key, target);
          const downloaded = now();
          const verified = await sha256(target) === blob.sha256;
          const result = { size, uploadSeconds: (uploaded - started) / 1000, uploadMBps: size / ((uploaded - started) / 1000), downloadSeconds: (downloaded - uploaded) / 1000, downloadMBps: size / ((downloaded - uploaded) / 1000), verified };
          log(result); results.push(result);
          await rm(target, { force: true });
        } catch (error) {
          const result = { size, error: error.code ?? error.message, message: error.message, serverMessage: error.serverMessage, seconds: (now() - started) / 1000 };
          log(result); results.push(result);
        }
        await rm(blob.file, { force: true });
      }
    } finally {
      if (!keep) await store.deleteBook(book);
      await rm(directory, { recursive: true, force: true });
    }
    return { results, retries };
  },

  // Uploads `count` blobs of `size` MB, `concurrency` at a time, then downloads them; notes throttling.
  async burst({ count = 200, size = 5, concurrency = 1 } = {}) {
    const book = zoneName('burst');
    const directory = await mkdtemp(join(tmpdir(), 'ck-'));
    // One file per worker, made distinct per upload by its key (content-addressing is the caller's job).
    const files = await Promise.all(Array.from({ length: concurrency }, () => randomFile(directory, size)));
    const keys = Array.from({ length: count }, (_, index) => 'books/' + book + '/originals/' + String(index).padStart(5, '0') + '.bin');
    const timings = [];
    try {
      let next = 0;
      const started = now();
      await Promise.all(files.map(async (blob) => {
        while (next < keys.length) {
          const key = keys[next++];
          const one = now();
          await store.putIfAbsent(key, { file: blob.file });
          timings.push((now() - one) / 1000);
          if (timings.length % 25 === 0) log({ uploaded: timings.length, elapsed: (now() - started) / 1000 });
        }
      }));
      const uploadSeconds = (now() - started) / 1000;
      const listStarted = now();
      const listed = await store.list('books/' + book + '/');
      const listSeconds = (now() - listStarted) / 1000;
      next = 0;
      const downStarted = now();
      await Promise.all(files.map(async (_, worker) => {
        while (next < keys.length) {
          const key = keys[next++];
          const target = join(directory, 'd-' + worker);
          await store.download(key, target);
          await rm(target, { force: true });
        }
      }));
      const downloadSeconds = (now() - downStarted) / 1000;
      timings.sort((a, b) => a - b);
      return {
        count, size, concurrency, listed: listed.length,
        uploadSeconds, uploadMBps: (count * size) / uploadSeconds, perUploadMedian: timings[timings.length >> 1], perUploadP95: timings[Math.floor(timings.length * 0.95)],
        downloadSeconds, downloadMBps: (count * size) / downloadSeconds, listSeconds, retries,
      };
    } finally {
      await store.deleteBook(book);
      await rm(directory, { recursive: true, force: true });
    }
  },

  // One side of the conditional-create race: waits until `at` (epoch ms), then creates the record.
  async race({ zone, name, at, label }) {
    await store.ensureZone(zone);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));
    const started = Date.now();
    const result = await store.putIfAbsent('books/' + zone + '/' + name, new TextEncoder().encode(label));
    const winner = new TextDecoder().decode(await store.get('books/' + zone + '/' + name));
    return { label, started, existed: result.existed, winner };
  },

  // Seeds a zone with `count` small records, then times a full listing and a listing of changes since a token.
  async listing({ count = 3000, keep = false } = {}) {
    const book = zoneName('listing');
    await store.ensureZone(book);
    try {
      const seedStarted = now();
      for (let start = 0; start < count; start += 400) {
        const batch = Array.from({ length: Math.min(400, count - start) }, (_, offset) => ({ name: 'content/' + String(start + offset).padStart(6, '0'), bytes: randomBytes(64) }));
        await native.saveMany(book, batch);
      }
      const seedSeconds = (now() - seedStarted) / 1000;
      const fullStarted = now();
      const full = await store.changes(book);
      const fullSeconds = (now() - fullStarted) / 1000;
      const unchangedStarted = now();
      const unchanged = await store.changes(book, full.token);
      const unchangedSeconds = (now() - unchangedStarted) / 1000;
      await native.saveMany(book, Array.from({ length: 10 }, (_, index) => ({ name: 'snapshots/new-' + index + '.json', bytes: randomBytes(64) })));
      await store.delete(['books/' + book + '/content/000000']);
      const deltaStarted = now();
      const delta = await store.changes(book, full.token);
      const deltaSeconds = (now() - deltaStarted) / 1000;
      const listStarted = now();
      const viaList = await store.list('books/' + book + '/');
      const listSeconds = (now() - listStarted) / 1000;
      return {
        count, seedSeconds, full: { records: full.changed.length, seconds: fullSeconds, tokenBytes: full.token?.length },
        unchanged: { changed: unchanged.changed.length, deleted: unchanged.deleted.length, seconds: unchangedSeconds },
        delta: { changed: delta.changed.length, deleted: delta.deleted, seconds: deltaSeconds },
        list: { keys: viaList.length, seconds: listSeconds }, retries,
      };
    } finally {
      if (!keep) await store.deleteBook(book);
    }
  },

  async zones() { return native.listZones(); },

  // Downloads every record of a zone (uploaded on another Mac), `concurrency` at a time, checking SHA-256.
  async pull({ zone, concurrency = 1 }) {
    const directory = await mkdtemp(join(tmpdir(), 'ck-'));
    try {
      const listStarted = now();
      const records = await store.list('books/' + zone + '/');
      const listSeconds = (now() - listStarted) / 1000;
      const results = [];
      let next = 0;
      const started = now();
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        while (next < records.length) {
          const record = records[next++];
          const target = join(directory, 'p-' + worker);
          const one = now();
          await store.download(record.key, target);
          const seconds = (now() - one) / 1000;
          const expected = /([0-9a-f]{64})/.exec(record.key)?.[1];
          const verified = expected ? (await sha256(target)) === expected : undefined;
          const entry = { key: record.key, megabytes: mb(record.size), seconds, mbps: mb(record.size) / seconds, verified };
          log(entry); results.push(entry);
          await rm(target, { force: true });
        }
      }));
      const seconds = (now() - started) / 1000;
      const total = results.reduce((sum, entry) => sum + entry.megabytes, 0);
      return { records: records.length, listSeconds, seconds, megabytes: total, mbps: total / seconds, allVerified: results.every((entry) => entry.verified !== false) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },

  // Question 4 across Macs: both Macs run this with the same `start` (epoch ms) and `zone`; round i fires at
  // start + i × 5 s on each, with the Macs' clocks as the only synchronization.
  async racemany({ zone, start, rounds = 10, label }) {
    await store.ensureZone(zone);
    const results = [];
    for (let round = 0; round < rounds; round++) {
      const at = start + round * 5000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));
      const fired = Date.now();
      const name = 'books/' + zone + '/snapshots/race-' + round + '.json';
      const { existed } = await store.putIfAbsent(name, new TextEncoder().encode(label));
      const entry = { round, firedLateMs: fired - at, created: !existed };
      log(entry); results.push(entry);
    }
    // Read every winner after both Macs are done.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    for (const entry of results) entry.winner = new TextDecoder().decode(await store.get('books/' + zone + '/snapshots/race-' + entry.round + '.json'));
    return { label, created: results.filter((entry) => entry.created).map((entry) => entry.round), winners: results.map((entry) => entry.winner) };
  },

  // Question 8: subscribes to the private database and logs every push for `seconds`. Run `touch` elsewhere.
  async listen({ seconds = 120 } = {}) {
    const { pushNotifications } = require('electron');
    const pushes = [];
    pushNotifications.on('received-apns-notification', (_event, userInfo) => {
      pushes.push({ at: new Date().toISOString(), userInfo });
      log({ push: userInfo });
    });
    const token = await pushNotifications.registerForAPNSNotifications();
    log({ apnsToken: token.slice(0, 12) + '…' });
    await native.saveSubscription('private-changes');
    log({ subscribed: true, listeningSeconds: seconds });
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { pushes };
  },

  // Writes one record to the `spike-push` zone, to trigger a push on a listening Mac.
  async touch() {
    const key = 'books/spike-push/snapshots/' + randomUUID() + '.json';
    await store.putIfAbsent(key, new TextEncoder().encode('{}'));
    return { key, at: new Date().toISOString() };
  },

  // Question 6: every `interval` seconds, reads the account status and tries a small write and read, logging
  // the outcome. Toggle Wi-Fi, iCloud for the app, or sign out meanwhile and watch the codes.
  async watch({ seconds = 300, interval = 5 } = {}) {
    native.onAccountChange(() => log({ at: new Date().toISOString(), event: 'accountChanged' }));
    const outcomes = [];
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const entry = { at: new Date().toISOString() };
      try { entry.account = (await native.status()).accountStatus; } catch (error) { entry.account = error.code; }
      const started = now();
      try {
        await native.saveZone('spike-watch');
        await native.putIfAbsent('spike-watch', 'probe-' + randomUUID(), { bytes: Buffer.from('x') }, {});
        entry.write = 'ok';
      } catch (error) { entry.write = error.code; entry.message = error.message; if (error.retryAfter) entry.retryAfter = error.retryAfter; }
      entry.seconds = Math.round((now() - started) / 100) / 10;
      log(entry); outcomes.push(entry);
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
    return { outcomes: outcomes.length };
  },

  // Deletes every zone this spike made (`spike-*`, `probe`, `index`).
  async cleanup() {
    const zones = (await native.listZones()).filter((zone) => zone.startsWith('spike-') || zone === 'probe' || zone === 'index');
    if (zones.length) await native.deleteZones(zones);
    return { deleted: zones };
  },
};

app.dock?.hide();
app.whenReady().then(async () => {
  const started = now();
  try {
    const status = await native.status();
    if (task !== 'status' && (!status.entitled || status.accountStatus !== 'available')) throw Object.assign(new Error('CloudKit unavailable'), { code: 'unavailable', status });
    const result = await tasks[task](options);
    log({ done: true, task, seconds: (now() - started) / 1000, result });
  } catch (error) {
    log({ done: true, task, error: error.code ?? 'error', message: error.message, serverMessage: error.serverMessage, status: error.status, stack: error.code ? undefined : error.stack });
    process.exitCode = 1;
  }
  app.quit();
});

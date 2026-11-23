// The object store of #278 over CloudKit's private database (the addon in native/cloudkit.mm).
//
// Keys map onto zones and records:
//   books/<bookId>/deleted.json  → zone `index`, record `books/<bookId>/deleted.json` (survives deleting the book's zone)
//   books/<bookId>/<rest>        → zone `<bookId>`, record `<rest>`
//   anything else (remote.json)  → zone `index`, record `<key>`
// `listPrefixes('books/')` lists zones; deleting a whole book deletes its zone.
const native = require('./build/cloudkit.node');

const INDEX = 'index';
let nextId = 1;

function locate(key) {
  const match = /^books\/([^/]+)\/(.+)$/.exec(key);
  if (!match || match[2] === 'deleted.json') return { zone: INDEX, name: key };
  return { zone: match[1], name: match[2] };
}

function keyOf(zone, name) {
  return zone === INDEX ? name : 'books/' + zone + '/' + name;
}

function withSignal(signal, run) {
  if (!signal) return run(undefined);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  const id = nextId++;
  const abort = () => native.cancel(id);
  signal.addEventListener('abort', abort, { once: true });
  return run(id).finally(() => signal.removeEventListener('abort', abort));
}

// Retries what CloudKit asks to be retried, waiting as long as it says.
async function retrying(run, { attempts = 6, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      const retryable = ['requestRateLimited', 'zoneBusy', 'serviceUnavailable', 'networkFailure'].includes(error.code);
      if (!retryable || attempt >= attempts) throw error;
      const seconds = error.retryAfter ?? Math.min(30, 2 ** attempt);
      onRetry?.(error, seconds);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

class CloudKitStore {
  constructor({ onRetry } = {}) {
    this.onRetry = onRetry;
    this.zones = new Set();
  }

  async status() { return native.status(); }

  async ensureZone(zone) {
    if (this.zones.has(zone)) return;
    await retrying(() => native.saveZone(zone), this);
    this.zones.add(zone);
  }

  // Creates the zone on first use and saves again when CloudKit reports it missing.
  async inZone(zone, run) {
    await this.ensureZone(zone);
    try { return await retrying(run, this); }
    catch (error) {
      if (error.code !== 'zoneNotFound' && error.code !== 'userDeletedZone') throw error;
      this.zones.delete(zone);
      await this.ensureZone(zone);
      return retrying(run, this);
    }
  }

  async putIfAbsent(key, source, options = {}) {
    const { zone, name } = locate(key);
    const value = source instanceof Uint8Array ? { bytes: Buffer.from(source.buffer, source.byteOffset, source.byteLength) } : { file: source.file };
    if (options.sha256) value.sha256 = options.sha256;
    const { created } = await this.inZone(zone, () => withSignal(options.signal, (id) => native.putIfAbsent(zone, name, value, { id, onProgress: options.onProgress })));
    return { existed: !created };
  }

  async get(key) {
    const { zone, name } = locate(key);
    const record = await retrying(() => native.fetch(zone, name, { mode: 'bytes' }), this).catch(missingZone);
    return record && new Uint8Array(record.bytes);
  }

  async download(key, file, options = {}) {
    const { zone, name } = locate(key);
    const record = await retrying(() => withSignal(options.signal, (id) => native.fetch(zone, name, { mode: 'file', file, id, onProgress: options.onProgress })), this).catch(missingZone);
    return !!record;
  }

  async head(key) {
    const { zone, name } = locate(key);
    const record = await retrying(() => native.fetch(zone, name, { mode: 'head' }), this).catch(missingZone);
    return record && { size: record.size, lastModified: new Date(record.lastModified) };
  }

  // Every key under a prefix. A book's prefix is one zone listing; the index zone is listed for the rest.
  async list(prefix) {
    const match = /^books\/([^/]+)\//.exec(prefix);
    const zones = match ? [match[1]] : [INDEX];
    const result = [];
    for (const zone of zones) {
      const { changed } = await retrying(() => native.changes(zone), this).catch((error) => { if (isMissingZone(error)) return { changed: [] }; throw error; });
      for (const record of changed) {
        const key = keyOf(zone, record.name);
        if (key.startsWith(prefix)) result.push({ key, size: record.size, lastModified: new Date(record.lastModified) });
      }
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }

  // Changes in a book since a token (the replacement for the commit header cache).
  async changes(bookId, token) {
    return retrying(() => native.changes(bookId, token), this);
  }

  async listPrefixes(prefix) {
    if (prefix !== 'books/') throw new Error('Only books/ has child prefixes in the CloudKit store.');
    const zones = await retrying(() => native.listZones(), this);
    return zones.filter((zone) => zone !== INDEX).map((zone) => 'books/' + zone + '/').sort();
  }

  async delete(keys) {
    const byZone = new Map();
    for (const key of keys) {
      const { zone, name } = locate(key);
      byZone.set(zone, [...(byZone.get(zone) ?? []), name]);
    }
    for (const [zone, names] of byZone) {
      for (let start = 0; start < names.length; start += 400) {
        await retrying(() => native.deleteRecords(zone, names.slice(start, start + 400)), this).catch((error) => { if (!isMissingZone(error)) throw error; });
      }
    }
  }

  // Not part of #278: deleting a book is deleting its zone.
  async deleteBook(bookId) {
    await retrying(() => native.deleteZones([bookId]), this).catch((error) => { if (!isMissingZone(error)) throw error; });
    this.zones.delete(bookId);
  }
}

function isMissingZone(error) {
  return error.code === 'zoneNotFound' || error.code === 'userDeletedZone';
}

function missingZone(error) {
  if (isMissingZone(error)) return undefined;
  throw error;
}

module.exports = { CloudKitStore, native, locate };

import { useEffect, useState } from 'react';
import type { DesktopApi, SyncBackendState, SyncConnectionReport, SyncSetupBook } from './desktop';
import type { AppSettings, S3SyncBackend, SyncBackend } from './settings';
import { splitEndpoint } from './sync-endpoint';

type Fields = { endpoint: string; region: string; bucket: string; prefix: string; addressing: '' | 'path' | 'virtual'; accessKeyId: string; secretAccessKey: string };
const fieldsOf = (backend?: S3SyncBackend): Fields => ({ endpoint: backend?.endpoint ?? '', region: backend?.region ?? '', bucket: backend?.bucket ?? '',
  prefix: backend?.prefix ?? '', addressing: backend?.addressing ?? '', accessKeyId: '', secretAccessKey: '' });

/** A size as Finder and iCloud show it: decimal units, one decimal from MB on. */
export function formatStorage(bytes: number) {
  if (bytes < 1000) return bytes + ' bytes';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[unit];
}

/** What Test Connection found, in words. */
export function describeReport(report: SyncConnectionReport) {
  return ['Connected.',
    report.conditionalWrites === 'enforced' ? 'The service refuses to replace an object (conditional writes).'
      : report.conditionalWrites === 'unsupported' ? 'The service has no conditional writes; ImageFlow looks before each upload.'
      : 'The service ignores conditional writes; ImageFlow looks before each upload.',
    report.checksums === 'verified' ? 'It checks the SHA-256 of every upload.' : 'It does not check SHA-256 checksums; ImageFlow checks each upload as it sends it.',
  ].join(' ');
}

/**
 * Settings → Sync (#281, shipped with the library in #283): the one backend this Mac syncs through (ADR 0012), off until
 * one is chosen and none preselected: an S3-compatible bucket with its access key and Test Connection, or iCloud where
 * this build offers it (its own flag until #292 is done). A folder is offered only for development and tests
 * (`IMAGEFLOW_SYNC_FOLDER=1`), chosen in the app's own dialog. Keep originals and the folder for downloaded books are
 * here too. The secret access key is sent to the main process when saved or tested and then cleared here; the main
 * process never sends it back.
 */
export function SyncSettings({ api, settings, choose }: { api?: DesktopApi; settings?: AppSettings; choose: (patch: Partial<AppSettings>) => Promise<void> }) {
  const configured = settings?.sync?.kind === 's3' ? settings.sync : undefined;
  const [fields, setFields] = useState<Fields>(() => fieldsOf(configured));
  const [state, setState] = useState<SyncBackendState>();
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'remove'>('');
  const [result, setResult] = useState<{ text: string; error?: boolean }>();
  // The kind of backend shown: the configured one, or the one picked to set up. Nothing is preselected.
  const [kind, setKind] = useState<'' | SyncBackend['kind']>(settings?.sync?.kind ?? '');
  const configuredKind = settings?.sync?.kind;
  useEffect(() => { if (configuredKind) setKind(configuredKind); }, [configuredKind]);
  const configuredKey = JSON.stringify(configured ?? null);
  useEffect(() => { setFields((current) => ({ ...fieldsOf(configured), accessKeyId: current.accessKeyId, secretAccessKey: current.secretAccessKey })); }, [configuredKey]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.syncBackendState().then((answer) => { if (active && 'value' in answer) setState(answer.value); });
    return () => { active = false; };
  }, [api, configuredKey]);

  // What the books take up in iCloud: asked when iCloud is the backend, from the key indexes after the first time.
  const [usage, setUsage] = useState<{ bytes: number; books: number } | { error: string } | 'counting'>();
  const usesICloud = settings?.sync?.kind === 'icloud';
  useEffect(() => {
    if (!api || !usesICloud) { setUsage(undefined); return; }
    let active = true;
    setUsage('counting');
    void api.syncUsage().then((answer) => { if (active) setUsage('value' in answer ? answer.value : { error: answer.error }); },
      () => { if (active) setUsage({ error: 'ImageFlow could not complete the request.' }); });
    return () => { active = false; };
  }, [api, usesICloud]);

  // The first-configuration sheet (ADR 0012, section 3): once a backend is saved where sync was off, the recent books
  // with what their originals take up, to choose which sync. Nothing is uploaded before; books left out are opted out.
  const [setup, setSetup] = useState<{ books: SyncSetupBook[]; chosen: Record<string, boolean>; saving?: boolean; error?: string }>();
  async function offerBooks() {
    if (!api) return;
    const answer = await api.syncSetupBooks().catch(() => ({ error: 'ImageFlow could not complete the request.' }));
    if ('error' in answer) { setResult({ text: answer.error, error: true }); return; }
    if (!answer.value.length) return;
    // Preselected: the books that sync already and the trusted ones; an untrusted book is trusted only when chosen.
    setSetup({ books: answer.value, chosen: Object.fromEntries(answer.value.map((book) => [book.id, book.syncing || book.trusted])) });
  }
  async function chooseBooks() {
    if (!api || !setup) return;
    setSetup({ ...setup, saving: true, error: undefined });
    const answer = await api.chooseSyncBooks(setup.books.map(({ id }) => ({ id, sync: !!setup.chosen[id] }))).catch(() => ({ error: 'ImageFlow could not complete the request.' }));
    if ('error' in answer) { setSetup({ ...setup, saving: false, error: answer.error }); return; }
    const count = setup.books.filter(({ id }) => setup.chosen[id]).length;
    setSetup(undefined);
    setState((current) => current && { ...current, booksUnchosen: undefined });
    setResult({ text: count ? (count === 1 ? '1 book syncs' : count + ' books sync') + ' from the next time it opens, or now if it is open.' : 'No book syncs until you choose File → Sync → Start Syncing in it.' });
  }
  // The main process says when books wait to be chosen (a backend was set up or changed); the sheet shows until it is
  // answered, also after Settings was closed or the app quit.
  const unchosen = !!state?.booksUnchosen;
  useEffect(() => { if (unchosen && !setup) void offerBooks(); }, [unchosen]);

  const set = (name: keyof Fields) => (event: { target: { value: string } }) => { setFields({ ...fields, [name]: event.target.value }); setResult(undefined); };
  /**
   * A URL with the bucket in it (R2 shows `https://<account>.r2.cloudflarestorage.com/<bucket>`) is split when pasted or
   * left: the server stays in Endpoint, the bucket goes to Bucket when that is empty, and a different name there is
   * pointed out. The main process splits it the same way, so a stored setting never holds a path.
   */
  const splitInto = (current: Fields, value: string): Fields => {
    const split = splitEndpoint(value);
    if ('error' in split) { if (value.trim()) setResult({ text: split.error, error: true }); return { ...current, endpoint: value }; }
    if (!split.bucket) return { ...current, endpoint: value.trim() === split.endpoint + '/' ? split.endpoint : value };
    const bucket = current.bucket.trim();
    setResult(!bucket || bucket === split.bucket ? { text: 'Took the bucket “' + split.bucket + '” from the URL.' }
      : { text: 'The URL names the bucket “' + split.bucket + '”, but Bucket is “' + bucket + '”. Enter the one to sync with.', error: true });
    return { ...current, endpoint: split.endpoint, bucket: bucket || split.bucket, region: current.region.trim() || split.region || current.region };
  };
  const backend = (): S3SyncBackend => ({ kind: 's3', endpoint: fields.endpoint.trim(), region: fields.region.trim(), bucket: fields.bucket.trim(),
    ...(fields.prefix.trim() ? { prefix: fields.prefix.trim() } : {}), ...(fields.addressing ? { addressing: fields.addressing } : {}) });
  const entered = fields.accessKeyId.trim() || fields.secretAccessKey ? { accessKeyId: fields.accessKeyId.trim(), secretAccessKey: fields.secretAccessKey } : undefined;
  // Stored credentials belong to the configured server and bucket: shown only while the fields name the same.
  const typed = splitEndpoint(fields.endpoint);
  const sameBucket = !!configured && !('error' in typed) && configured.endpoint === typed.endpoint && configured.bucket === (fields.bucket.trim() || typed.bucket);
  const stored = sameBucket ? state?.credentials : undefined;

  async function chooseFolder() {
    if (!api) return;
    setBusy('save');
    setResult(undefined);
    try {
      const answer = await api.chooseSyncFolder();
      if ('error' in answer) setResult({ text: answer.error, error: true });
    } catch {
      setResult({ text: 'ImageFlow could not complete the request.', error: true });
    } finally { setBusy(''); }
  }

  async function chooseBooksFolder() {
    if (!api) return;
    const answer = await api.chooseBooksFolder().catch(() => ({ error: 'ImageFlow could not complete the request.' }));
    if ('error' in answer) setResult({ text: answer.error, error: true });
  }

  async function useICloud() {
    if (!api) return;
    setBusy('save');
    setResult(undefined);
    try {
      const answer = await api.saveSyncBackend({ backend: { kind: 'icloud' } });
      if ('error' in answer) { setResult({ text: answer.error, error: true }); return; }
      setState(answer.value);
      setResult({ text: 'Saved.' });
    } catch {
      setResult({ text: 'ImageFlow could not complete the request.', error: true });
    } finally { setBusy(''); }
  }

  async function act(action: 'test' | 'save' | 'off') {
    if (!api) return;
    setBusy(action === 'off' ? 'remove' : action);
    setResult(undefined);
    try {
      if (action === 'test') {
        const answer = await api.testSyncConnection({ backend: backend(), ...(entered ? { credentials: entered } : {}) });
        setResult('error' in answer ? { text: answer.error, error: true } : { text: describeReport(answer.value) });
        return;
      }
      const answer = await api.saveSyncBackend(action === 'off' ? null : { backend: backend(), ...(entered ? { credentials: entered } : {}) });
      if ('error' in answer) { setResult({ text: answer.error, error: true }); return; }
      setState(answer.value);
      // Stored in the main process: nothing of the key stays here.
      setFields((current) => ({ ...current, accessKeyId: '', secretAccessKey: '' }));
      if (action === 'off') { setKind(''); setSetup(undefined); }
      setResult({ text: action === 'off' ? 'Sync is off on this Mac.' : 'Saved.' });

    } catch {
      setResult({ text: 'ImageFlow could not complete the request.', error: true });
    } finally { setBusy(''); }
  }

  if (state && !state.available) return null;
  const disabled = !api || !settings || !!busy;
  const complete = !!fields.endpoint.trim() && !!fields.region.trim() && !!fields.bucket.trim() && (!!stored || (!!entered?.accessKeyId && !!entered.secretAccessKey));
  const folder = settings?.sync?.kind === 'folder' ? settings.sync.path : undefined;
  // A setting this build does not use (iCloud without its flag) leaves sync off, and says so.
  const unusable = state?.unusable;
  const current = !settings?.sync || unusable ? undefined : settings.sync.kind === 'folder' ? '“' + (folder!.split('/').filter(Boolean).at(-1) ?? folder) + '”'
    : settings.sync.kind === 'icloud' ? 'iCloud' : 'the bucket “' + settings.sync.bucket + '”';
  // iCloud is listed only by a build entitled to it (or while it is the setting), beside the bucket, neither preselected.
  const icloud = state?.icloud;
  const icloudListed = !!icloud || settings?.sync?.kind === 'icloud';
  return <div className="settings-form sync-settings">
    <span className="settings-label" id="sync-through-label">Sync through:</span>
    <div className="settings-control">
      <div className="appearance-options" role="radiogroup" aria-labelledby="sync-through-label">
        {icloudListed && <label><input type="radio" name="sync-kind" value="icloud" disabled={disabled} checked={kind === 'icloud'} onChange={() => { setKind('icloud'); setResult(undefined); }} /><span>iCloud</span></label>}
        <label><input type="radio" name="sync-kind" value="s3" disabled={disabled} checked={kind === 's3'} onChange={() => { setKind('s3'); setResult(undefined); }} /><span>S3-compatible bucket</span></label>
        {(state?.folder || kind === 'folder') && <label><input type="radio" name="sync-kind" value="folder" disabled={disabled} checked={kind === 'folder'} onChange={() => { setKind('folder'); setResult(undefined); }} /><span>Folder</span></label>}
      </div>
      <p className="settings-note sync-backend" title={folder}>{current ? 'Books sync through ' + current + '.' : unusable ?? 'Sync is off: books do not sync on this Mac.'}</p>
      {settings?.sync && <div className="settings-update-actions"><button disabled={disabled} onClick={() => void act('off')}>Turn Off</button></div>}
      {kind !== 's3' && result && <p role={result.error ? 'alert' : 'status'} className={result.error ? 'error-text' : 'settings-note sync-test-result'}>{result.text}</p>}
    </div>
    {kind === 'icloud' && <>
      <span className="settings-label">iCloud:</span>
      <div className="settings-control">
        <p className="settings-note">{icloud?.available === false ? icloud.message
          : 'Books sync through your private iCloud database, with the Apple ID this Mac is signed in to. Their originals count toward your iCloud storage.'}</p>
        {usesICloud && usage && <p className="settings-note sync-usage" role="status">{usage === 'counting' ? 'Counting what ImageFlow stores in iCloud…'
          : 'error' in usage ? 'What ImageFlow stores in iCloud cannot be counted now: ' + usage.error
          : usage.books ? 'ImageFlow uses ' + formatStorage(usage.bytes) + ' of your iCloud storage for ' + usage.books + (usage.books === 1 ? ' book.' : ' books.')
          : 'No books are stored in iCloud yet.'}</p>}
        {settings?.sync?.kind !== 'icloud' && <div className="settings-update-actions">
          <button className="primary" disabled={disabled || !icloud?.available} onClick={() => void useICloud()}>Use iCloud</button>
        </div>}
      </div>
    </>}
    {kind === 'folder' && <>
      <span className="settings-label">Folder:</span>
      <div className="settings-control">
        <div className="settings-update-actions" style={{ marginTop: 0 }}>
          <button disabled={disabled} onClick={() => void chooseFolder()}>{folder ? 'Change Folder…' : 'Choose Folder…'}</button>
        </div>
        <p className="settings-note">For development and tests: a folder outside every book, not one iCloud Drive or Dropbox manages.</p>
      </div>
    </>}
    {kind === 's3' && <>
    <span className="settings-label">Bucket:</span>
    <div className="settings-control sync-fields">
      <input aria-label="Endpoint" placeholder="https://s3.us-east-1.amazonaws.com" value={fields.endpoint} disabled={disabled} onChange={set('endpoint')} spellCheck={false} autoComplete="off"
        onBlur={(event) => setFields(splitInto(fields, event.target.value))}
        onPaste={(event) => {
          // What the field holds after the paste, split at once.
          const { selectionStart, selectionEnd, value } = event.currentTarget;
          const next = value.slice(0, selectionStart ?? value.length) + event.clipboardData.getData('text').trim() + value.slice(selectionEnd ?? value.length);
          event.preventDefault();
          setResult(undefined);
          setFields(splitInto(fields, next));
        }} />
      <div className="sync-field-row">
        <input aria-label="Bucket" placeholder="Bucket" value={fields.bucket} disabled={disabled} onChange={set('bucket')} spellCheck={false} autoComplete="off" />
        <input aria-label="Region" placeholder="Region (auto for R2)" value={fields.region} disabled={disabled} onChange={set('region')} spellCheck={false} autoComplete="off" />
      </div>
      <div className="sync-field-row">
        <input aria-label="Prefix" placeholder="Prefix (optional)" value={fields.prefix} disabled={disabled} onChange={set('prefix')} spellCheck={false} autoComplete="off" />
        <select aria-label="Addressing" value={fields.addressing} disabled={disabled} onChange={set('addressing')} title="How the bucket is named in URLs.">
          <option value="">Automatic</option><option value="path">Path style</option><option value="virtual">Virtual-hosted</option>
        </select>
      </div>
      <p className="settings-note">S3, Cloudflare R2, Backblaze B2, MinIO or Wasabi. The access key needs to read, write, list and delete under the prefix.</p>
    </div>
    <span className="settings-label">Access key:</span>
    <div className="settings-control sync-fields">
      <input aria-label="Access key ID" placeholder={stored ? 'Stored (…' + stored.accessKeyEnd + ')' : 'Access key ID'} value={fields.accessKeyId} disabled={disabled} onChange={set('accessKeyId')} spellCheck={false} autoComplete="off" />
      <input aria-label="Secret access key" type="password" placeholder={stored ? 'Stored' : 'Secret access key'} value={fields.secretAccessKey} disabled={disabled} onChange={set('secretAccessKey')} autoComplete="off" />
      <p className="settings-note">Encrypted with a key in this Mac’s keychain and kept apart from the other settings.</p>
      <div className="settings-update-actions">
        <button disabled={disabled || !complete} onClick={() => void act('test')}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</button>
        <button className="primary" disabled={disabled || !complete} onClick={() => void act('save')}>Save</button>
      </div>
      {result && <p role={result.error ? 'alert' : 'status'} className={result.error ? 'error-text' : 'settings-note sync-test-result'}>{result.text}</p>}
    </div>
    </>}
    {setup && <>
      <span className="settings-label">Books:</span>
      <div className="settings-control sync-setup" role="group" aria-label="Books to sync">
        <p className="settings-note">Which books sync through {current ?? 'this backend'}? Nothing is uploaded until you choose. A book left out does not sync on this Mac until you choose File → Sync → Start Syncing in it.</p>
        <ul className="sync-setup-books">
          {setup.books.map((book) => <li key={book.id}><label>
            <input type="checkbox" checked={!!setup.chosen[book.id]} disabled={setup.saving} onChange={(event) => setSetup({ ...setup, chosen: { ...setup.chosen, [book.id]: event.target.checked } })} />
            <span className="sync-setup-title">{book.title || 'Untitled'}</span>
            <span className="settings-note">{book.bytes ? formatStorage(book.bytes) + ' of originals' : 'No originals'}{book.trusted ? '' : ' · not trusted on this Mac: choosing it trusts it'}</span>
          </label></li>)}
        </ul>
        <div className="settings-update-actions">
          <button className="primary" disabled={setup.saving} onClick={() => void chooseBooks()}>Sync Chosen Books</button>
        </div>
        {setup.error && <p role="alert" className="error-text">{setup.error}</p>}
      </div>
    </>}
    <span className="settings-label">Downloads:</span>
    <div className="settings-control">
      <p className="settings-note sync-books-folder" title={settings?.booksFolder}>Books you download from the Start window are saved in {settings?.booksFolder
        ? '“' + (settings.booksFolder.split('/').filter(Boolean).at(-1) ?? settings.booksFolder) + '”' : 'Documents → ImageFlow'}.</p>
      <div className="settings-update-actions" style={{ marginTop: 0 }}>
        <button disabled={!api || !settings} onClick={() => void chooseBooksFolder()}>Change Folder…</button>
      </div>
    </div>
    <span className="settings-label">Originals:</span>
    <div className="settings-control">
      <label className="pc-switch" title="Synced books download their originals in the background. Off: only previews, until File → Sync → Download Originals.">
        <input type="checkbox" checked={settings?.keepOriginals !== false} disabled={!settings}
          onChange={(event) => void choose({ keepOriginals: event.target.checked })} />Keep originals of synced books on this Mac</label>
    </div>
    <span className="settings-label">Automatic:</span>
    <div className="settings-control">
      <label className="pc-switch" title="Books take changes from your other Macs when they open or come to the front, and send their own after you stop editing and when they close. A book changed on two Macs waits for File → Sync → Sync Now.">
        <input type="checkbox" checked={settings?.syncAutomatically !== false} disabled={!settings}
          onChange={(event) => void choose({ syncAutomatically: event.target.checked })} />Sync automatically</label>
    </div>
  </div>;
}

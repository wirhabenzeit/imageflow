import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, SyncBackendState, SyncConnectionReport } from './desktop';
import type { AppSettings, S3SyncBackend, SyncBackend } from './settings';
import { splitEndpoint } from './sync-endpoint';

type Fields = { endpoint: string; region: string; bucket: string; prefix: string; addressing: '' | 'path' | 'virtual'; accessKeyId: string; secretAccessKey: string };
const fieldsOf = (backend?: S3SyncBackend): Fields => ({ endpoint: backend?.endpoint ?? '', region: backend?.region ?? '', bucket: backend?.bucket ?? '',
  prefix: backend?.prefix ?? '', addressing: backend?.addressing ?? '', accessKeyId: '', secretAccessKey: '' });
const failed = { error: 'ImageFlow could not complete the request.' };
type Message = { text: string; error?: boolean };

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
 * Settings → Sync (#306): the one backend this Mac syncs through (ADR 0012), off until one is chosen and none
 * preselected, and how it syncs. Off and iCloud (where this build offers it) take one click; a bucket has its fields in
 * a sheet, which Save stores and Cancel leaves alone. A folder is offered only for development and tests
 * (`IMAGEFLOW_SYNC_FOLDER=1`), chosen in the app's own dialog. Which books sync is the Sync window's.
 *
 * The pane is as high as its sheet needs in every state, so the window never changes height while it is used: errors
 * have a line kept for them, and what a row says stays on that row.
 */
export function SyncSettings({ api, settings, choose }: { api?: DesktopApi; settings?: AppSettings; choose: (patch: Partial<AppSettings>) => Promise<void> }) {
  const [state, setState] = useState<SyncBackendState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const configuredKey = JSON.stringify(settings?.sync ?? null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.syncBackendState().then((answer) => { if (active && 'value' in answer) setState(answer.value); });
    return () => { active = false; };
  }, [api, configuredKey]);

  async function act(request: () => Promise<{ error: string } | { value: unknown }>) {
    if (!api) return;
    setBusy(true);
    setError('');
    const answer = await request().catch(() => failed);
    if ('error' in answer) setError(answer.error);
    setBusy(false);
  }
  /** Off, iCloud and a folder are chosen at once; a bucket once its sheet is saved. Until it took, the former choice shows. */
  function pick(kind: 'off' | SyncBackend['kind']) {
    if (!api) return;
    if (kind === 's3') { setError(''); setEditing(true); }
    else if (kind === 'folder') void act(() => api.chooseSyncFolder());
    else void act(() => api.saveSyncBackend(kind === 'off' ? null : { backend: { kind: 'icloud' } }));
  }

  if (state && !state.available) return null;
  const disabled = !api || !settings || busy;
  const sync = settings?.sync;
  const current = sync?.kind ?? 'off';
  // iCloud is listed only by a build entitled to it (or while it is the setting), beside the bucket, neither preselected.
  const kinds: { kind: 'off' | SyncBackend['kind']; label: string }[] = [{ kind: 'off', label: 'Off' },
    ...(state?.icloud || current === 'icloud' ? [{ kind: 'icloud' as const, label: 'iCloud' }] : []), { kind: 's3', label: 'S3 bucket' },
    ...(state?.folder || current === 'folder' ? [{ kind: 'folder' as const, label: 'Folder' }] : [])];
  const on = !!sync && !state?.unusable;
  // A setting this build does not use (iCloud without its entitlements), or an iCloud that cannot be used now, says so.
  const problem = error || state?.unusable || (current === 'icloud' && state?.icloud?.available === false ? state.icloud.message : '') || '';
  const place = sync?.kind === 's3' ? sync.bucket : sync?.kind === 'folder' ? sync.path.split('/').filter(Boolean).at(-1) ?? sync.path : '';
  return <div className="settings-form sync-settings">
    <span className="settings-label" id="sync-through-label">Sync through:</span>
    <div className="settings-control sync-through">
      <div className="appearance-options" role="radiogroup" aria-labelledby="sync-through-label">
        {kinds.map(({ kind, label }) => <label key={kind}>
          <input type="radio" name="sync-kind" value={kind} disabled={disabled} checked={!!settings && current === kind} onChange={() => pick(kind)} /><span>{label}</span></label>)}
      </div>
      {place && <><span className="sync-place" title={sync?.kind === 'folder' ? sync.path : place}>{place}</span>
        <button disabled={disabled} onClick={() => pick(sync!.kind)}>{sync!.kind === 's3' ? 'Edit…' : 'Change…'}</button></>}
    </div>
    <span className="settings-label">Books:</span>
    <div className="settings-control"><button disabled={disabled || !on} onClick={() => void api!.showSync()}>Manage Synced Books…</button></div>
    <span className="settings-label" id="sync-options-label">Options:</span>
    <div className="settings-control" role="group" aria-labelledby="sync-options-label">
      <label className="pc-switch" title="Books take changes from your other Macs when they open or come to the front, and send their own after you stop editing and when they close. A book changed on two Macs waits for File → Sync → Sync Now.">
        <input type="checkbox" checked={settings?.syncAutomatically !== false} disabled={!settings || !on}
          onChange={(event) => void choose({ syncAutomatically: event.target.checked })} />Sync automatically</label>
      <label className="pc-switch" title="Synced books download their originals in the background. Off: only previews, until File → Sync → Download Originals.">
        <input type="checkbox" checked={settings?.keepOriginals !== false} disabled={!settings || !on}
          onChange={(event) => void choose({ keepOriginals: event.target.checked })} />Keep originals on this Mac</label>
    </div>
    <p className={'sync-problem' + (problem ? ' error-text' : '')} role={problem ? 'alert' : undefined} title={problem || undefined}>{problem}</p>
    {editing && api && <BucketSheet api={api} configured={sync?.kind === 's3' ? sync : undefined} state={state} saved={setState} close={() => setEditing(false)} />}
  </div>;
}

/**
 * The bucket's fields, in a sheet over the pane. The secret access key is sent to the main process when saved or tested;
 * the main process never sends it back, and nothing of it stays here. Cancel (or Escape) changes nothing.
 */
function BucketSheet({ api, configured, state, saved, close }: { api: DesktopApi; configured?: S3SyncBackend; state?: SyncBackendState; saved: (state: SyncBackendState) => void; close: () => void }) {
  const [fields, setFields] = useState<Fields>(() => fieldsOf(configured));
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<Message>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
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
  const complete = !!fields.endpoint.trim() && !!fields.region.trim() && !!fields.bucket.trim() && (!!stored || (!!entered?.accessKeyId && !!entered.secretAccessKey));
  const disabled = !!busy;

  async function act(action: 'test' | 'save') {
    setBusy(action);
    setResult(undefined);
    const request = { backend: backend(), ...(entered ? { credentials: entered } : {}) };
    if (action === 'test') {
      const answer = await api.testSyncConnection(request).catch(() => failed);
      setResult('error' in answer ? { text: answer.error, error: true } : { text: describeReport(answer.value) });
      setBusy('');
      return;
    }
    const answer = await api.saveSyncBackend(request).catch(() => failed);
    if ('error' in answer) { setResult({ text: answer.error, error: true }); setBusy(''); return; }
    saved(answer.value);
    close();
  }
  return <dialog ref={dialog} className="sync-sheet" aria-labelledby="sync-sheet-title" onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <form className="sync-sheet-form" onSubmit={(event) => { event.preventDefault(); if (complete && !busy) void act('save'); }}>
      <h2 id="sync-sheet-title">S3-compatible bucket</h2>
      <input aria-label="Endpoint" placeholder="Endpoint, like https://s3.us-east-1.amazonaws.com" value={fields.endpoint} disabled={disabled} onChange={set('endpoint')} spellCheck={false} autoComplete="off"
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
          <option value="">Automatic addressing</option><option value="path">Path style</option><option value="virtual">Virtual-hosted</option>
        </select>
      </div>
      <div className="sync-field-row">
        <input aria-label="Access key ID" placeholder={stored ? 'Stored (…' + stored.accessKeyEnd + ')' : 'Access key ID'} value={fields.accessKeyId} disabled={disabled} onChange={set('accessKeyId')} spellCheck={false} autoComplete="off" />
        <input aria-label="Secret access key" type="password" placeholder={stored ? 'Stored' : 'Secret access key'} value={fields.secretAccessKey} disabled={disabled} onChange={set('secretAccessKey')} autoComplete="off" />
      </div>
      <p className={'sync-sheet-result' + (result?.error ? ' error-text' : '')} role={result?.error ? 'alert' : 'status'} title={result?.text}>{result?.text ?? 'The key is kept in this Mac’s keychain.'}</p>
      <div className="sync-sheet-actions">
        <button type="button" disabled={disabled || !complete} onClick={() => void act('test')}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</button>
        <button type="button" disabled={disabled} onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={disabled || !complete}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </dialog>;
}

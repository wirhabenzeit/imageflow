import { useEffect, useState } from 'react';
import type { DesktopApi, SyncBackendState, SyncConnectionReport } from './desktop';
import type { AppSettings, S3SyncBackend } from './settings';
import { splitEndpoint } from './sync-endpoint';

type Fields = { endpoint: string; region: string; bucket: string; prefix: string; addressing: '' | 'path' | 'virtual'; accessKeyId: string; secretAccessKey: string };
const fieldsOf = (backend?: S3SyncBackend): Fields => ({ endpoint: backend?.endpoint ?? '', region: backend?.region ?? '', bucket: backend?.bucket ?? '',
  prefix: backend?.prefix ?? '', addressing: backend?.addressing ?? '', accessKeyId: '', secretAccessKey: '' });

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
 * Settings → Sync (#281, behind the development flag): an S3-compatible bucket, its access key, Test Connection, and
 * Keep originals. The secret access key is sent to the main process when saved or tested and then cleared here; the
 * main process never sends it back.
 */
export function SyncSettings({ api, settings, choose }: { api?: DesktopApi; settings?: AppSettings; choose: (patch: Partial<AppSettings>) => Promise<void> }) {
  const configured = settings?.sync?.kind === 's3' ? settings.sync : undefined;
  const [fields, setFields] = useState<Fields>(() => fieldsOf(configured));
  const [state, setState] = useState<SyncBackendState>();
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'remove'>('');
  const [result, setResult] = useState<{ text: string; error?: boolean }>();
  const configuredKey = JSON.stringify(configured ?? null);
  useEffect(() => { setFields((current) => ({ ...fieldsOf(configured), accessKeyId: current.accessKeyId, secretAccessKey: current.secretAccessKey })); }, [configuredKey]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.syncBackendState().then((answer) => { if (active && 'value' in answer) setState(answer.value); });
    return () => { active = false; };
  }, [api, configuredKey]);

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

  async function act(kind: 'test' | 'save' | 'remove') {
    if (!api) return;
    setBusy(kind);
    setResult(undefined);
    try {
      if (kind === 'test') {
        const answer = await api.testSyncConnection({ backend: backend(), ...(entered ? { credentials: entered } : {}) });
        setResult('error' in answer ? { text: answer.error, error: true } : { text: describeReport(answer.value) });
        return;
      }
      const answer = await api.saveSyncBackend(kind === 'remove' ? null : { backend: backend(), ...(entered ? { credentials: entered } : {}) });
      if ('error' in answer) { setResult({ text: answer.error, error: true }); return; }
      setState(answer.value);
      // Stored in the main process: nothing of the key stays here.
      setFields((current) => ({ ...current, accessKeyId: '', secretAccessKey: '' }));
      setResult({ text: kind === 'remove' ? 'This Mac no longer syncs through a bucket.' : 'Saved.' });
    } catch {
      setResult({ text: 'ImageFlow could not complete the request.', error: true });
    } finally { setBusy(''); }
  }

  if (state && !state.available) return null;
  const disabled = !api || !settings || !!busy;
  const complete = !!fields.endpoint.trim() && !!fields.region.trim() && !!fields.bucket.trim() && (!!stored || (!!entered?.accessKeyId && !!entered.secretAccessKey));
  return <div className="settings-form sync-settings">
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
        {configured && <button disabled={disabled} onClick={() => void act('remove')}>Remove</button>}
      </div>
      {result && <p role={result.error ? 'alert' : 'status'} className={result.error ? 'error-text' : 'settings-note sync-test-result'}>{result.text}</p>}
    </div>
    <span className="settings-label">Originals:</span>
    <div className="settings-control">
      <label className="pc-switch" title="Synced books download their originals in the background. Off: only previews, until File → Sync → Download Originals.">
        <input type="checkbox" checked={settings?.keepOriginals !== false} disabled={!settings}
          onChange={(event) => void choose({ keepOriginals: event.target.checked })} />Keep originals of synced books on this Mac</label>
    </div>
  </div>;
}

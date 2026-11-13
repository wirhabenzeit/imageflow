import { useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { LibraryEntry } from './library';

/** A disposable preview of the template's sample or first opening spread, shared by both library views. */
export function TemplatePreview({ api, entry, natural = false }: { api?: DesktopApi; entry: LibraryEntry; natural?: boolean }) {
  const [preview, setPreview] = useState<{ hash: string; src: string }>();
  useEffect(() => {
    if (!api || entry.unavailable) return;
    let active = true;
    void api.templatePreview(entry.id, entry.hash).then((result) => {
      if (active && 'value' in result && result.value) setPreview({ hash: entry.hash, src: result.value });
    }).catch(() => {});
    return () => { active = false; };
  }, [api, entry.id, entry.hash, entry.unavailable, entry.networkTrust]);
  return <span className={'template-preview' + (natural ? ' natural' : '')} aria-hidden="true">
    {preview?.hash === entry.hash ? <img src={preview.src} alt="" /> : <span className="starter-page"><i /><i /><i /></span>}
  </span>;
}

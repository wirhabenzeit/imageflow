import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DesktopApi } from './desktop';
import { templatePictureURL } from './library';
import type { LibraryEntry } from './library';

/**
 * A picture of a template, shared by both library views. With `image`, the template's own preview image comes first,
 * cropped to fill the default format's shape. Then the library's saved render of the opening spread, then a render
 * made now, then a neutral placeholder. Saved pictures are tied to the template's hash, so they show on first paint.
 */
export function TemplatePreview({ api, entry, natural = false, image = false }: { api?: DesktopApi; entry: LibraryEntry; natural?: boolean; image?: boolean }) {
  const [preview, setPreview] = useState<{ hash: string; src: string }>();
  // Saved pictures that failed to load; the next one is shown instead.
  const [failed, setFailed] = useState<{ hash: string; sources: string[] }>();
  const saved = [
    ...(image && entry.image ? [{ src: templatePictureURL(entry.hash, 'image'), cover: true }] : []),
    ...(entry.render ? [{ src: templatePictureURL(entry.hash, 'render'), cover: false }] : []),
  ].filter(({ src }) => failed?.hash !== entry.hash || !failed.sources.includes(src));
  const live = !saved.length;
  useEffect(() => {
    if (!api || entry.unavailable || !live) return;
    let active = true;
    void api.templatePreview(entry.id, entry.hash).then((result) => {
      if (active && 'value' in result && result.value) setPreview({ hash: entry.hash, src: result.value });
    }).catch(() => {});
    return () => { active = false; };
  }, [api, entry.id, entry.hash, entry.unavailable, entry.networkTrust, live]);
  const shown = saved[0] ?? (preview?.hash === entry.hash ? { src: preview.src, cover: false } : undefined);
  const fail = () => {
    if (!shown) return;
    if (saved[0]) setFailed({ hash: entry.hash, sources: [...failed?.hash === entry.hash ? failed.sources : [], shown.src] });
    else setPreview(undefined);
  };
  return <span className={'template-preview' + (natural ? ' natural' : '')} aria-hidden="true">
    {shown ? <img key={shown.src} src={shown.src} alt="" onError={fail} className={shown.cover ? 'template-cover' : undefined}
      style={shown.cover ? { '--aspect': entry.aspect ?? 1.4 } as CSSProperties : undefined} />
      : <span className="starter-page"><i /><i /><i /></span>}
  </span>;
}

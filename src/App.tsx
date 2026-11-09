import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { layouts, pageLabel, photoCrop, photoUsage, textStyles } from './book';
import type { Alignment, Assets, LayoutId, Spread, StyleId } from './book';
import { exportBook, layoutSpread } from './bookRender';
import { demoAssets, demoSpreads } from './demo';
import { desktopCommandEvent, isDesktop } from './desktop';
import type { DesktopCommand } from './desktop';
import { Filmstrip } from './Filmstrip';
import type { ImportProgress } from './Filmstrip';
import { jpegAccept, preparePhoto } from './photo';
import { LayoutIcon, SpreadArtwork } from './SpreadCanvas';
import { centered } from './spread';
import type { Placement } from './spread';

type InspectorTab = 'layout' | 'content';
const maxSpreads = 30;
const standalone = window.location.protocol === 'file:';

function newId() {
  return [...crypto.getRandomValues(new Uint8Array(12))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function Icon({ name }: { name: 'book' | 'plus' | 'left' | 'right' | 'copy' | 'trash' | 'image' | 'arrow' }) {
  const paths = {
    book: 'M3 5.5h6a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H3z M21 5.5h-6a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h6z',
    plus: 'M12 5v14 M5 12h14',
    left: 'm15 6-6 6 6 6',
    right: 'm9 6 6 6-6 6',
    copy: 'M8 8h12v12H8z M4 16V4h12',
    trash: 'M4 7h16 M6 7l1 13h10l1-13 M9 7V4h6v3 M10 10v7 M14 10v7',
    image: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 5 M16 9h.01',
    arrow: 'M12 4v12 m-5-5 5 5 5-5 M5 19h14',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function App() {
  const [spreads, setSpreads] = useState(demoSpreads);
  const [assets, setAssets] = useState(demoAssets);
  const [activeId, setActiveId] = useState('arrival');
  const [frameId, setFrameId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>('layout');
  const [guides, setGuides] = useState(false);
  const [preview, setPreview] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [pickedPhoto, setPickedPhoto] = useState<string | null>(null);
  const [draggedPhoto, setDraggedPhoto] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const imported = useRef(new Map<string, string>());
  const importing = useRef(false);
  const exportingBook = useRef(false);

  useEffect(() => {
    const owned = urls.current;
    return () => { for (const url of owned) URL.revokeObjectURL(url); };
  }, []);

  const index = spreads.findIndex((spread) => spread.id === activeId);
  const spread = spreads[index];
  const layout = layouts[spread.layoutId];
  const canPlacePhoto = layout.frames.some((frame) => frame.type === 'photo');
  const usage = useMemo(() => photoUsage(spreads), [spreads]);
  const frame = layout.frames.find(({ id }) => id === frameId);
  const photo = frame?.type === 'photo' ? spread.photos[frame.id] : undefined;
  const asset = photo && assets[photo.assetId];
  const text = frame?.type === 'text' ? spread.text[frame.id] : undefined;
  const styleId = frame?.type === 'text' ? text?.style ?? frame.style : 'body';
  const crop = photo && asset && frame ? photoCrop(asset, frame, photo.placement) : undefined;
  const ppi = crop && asset && frame ? Math.round(asset.width * crop.width * 72 / frame.width) : undefined;
  const textOverflow = frame?.type === 'text' && layoutSpread(spread, assets).layers.some(
    (layer) => layer.type === 'text' && layer.id === frame.id && layer.overflow,
  );

  const update = useCallback((id: string, edit: (current: Spread) => Spread) => {
    setSpreads((items) => items.map((item) => item.id === id ? edit(item) : item));
  }, []);

  const assignPhoto = useCallback((spreadId: string, photoId: string, assetId: string) => {
    update(spreadId, (current) => {
      if (current.photos[photoId]?.assetId === assetId) return current;
      return { ...current, photos: { ...current.photos, [photoId]: { assetId, placement: centered } } };
    });
  }, [update]);

  function activate(id: string) {
    setActiveId(id);
    setFrameId(null);
    setTab('layout');
    setNotice('');
  }

  function add(duplicate: boolean) {
    if (spreads.length >= maxSpreads) return;
    const next: Spread = duplicate
      ? { ...spread, id: newId(), name: spread.name + ' copy' }
      : { id: newId(), name: 'Untitled spread', layoutId: 'story', photos: {}, text: {} };
    setSpreads((items) => [...items.slice(0, index + 1), next, ...items.slice(index + 1)]);
    activate(next.id);
  }

  function remove() {
    if (spreads.length < 2) return;
    setSpreads((items) => items.filter(({ id }) => id !== activeId));
    activate(spreads[index === 0 ? 1 : index - 1].id);
  }

  function reorder(offset: -1 | 1) {
    setSpreads((items) => {
      const next = [...items];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }

  function chooseLayout(id: LayoutId) {
    update(activeId, (current) => ({ ...current, layoutId: id }));
    setFrameId(null);
  }

  function selectFrame(id: string) {
    setFrameId(id);
    setTab('content');
    setNotice('');
  }

  function updateText(id: string, value: string) {
    update(activeId, (current) => ({
      ...current,
      text: { ...current.text, [id]: { ...current.text[id], value } },
    }));
  }

  function placePhoto(id: string, assetId: string) {
    if (!assets[assetId]) return;
    assignPhoto(activeId, id, assetId);
    setPickedPhoto(null);
    selectFrame(id);
  }

  function movePhoto(id: string, placement: Placement) {
    const frame = layout.frames.find((frame) => frame.id === id);
    if (!frame) return;
    update(activeId, (current) => {
      const content = current.photos[id];
      const asset = content && assets[content.assetId];
      if (!content || !asset) return current;
      const crop = photoCrop(asset, frame, placement);
      const clamped = { centerX: crop.x + crop.width / 2, centerY: crop.y + crop.height / 2, zoom: placement.zoom };
      return { ...current, photos: { ...current.photos, [id]: { ...content, placement: clamped } } };
    });
  }

  const importPhotos = useCallback(async (files: File[], target?: { spreadId: string; frameId: string }) => {
    if (importing.current || exportingBook.current || !files.length) return;
    importing.current = true;
    setNotice('');
    setImportProgress({ finished: 0, total: files.length });
    const ordered = [...files].sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }),
    );
    const additions: Assets = {};
    let duplicates = 0;
    let skipped = 0;
    let placedId: string | undefined;
    let lastError: string | undefined;
    try {
      for (const [index, file] of ordered.entries()) {
        const key = JSON.stringify([file.name, file.size, file.lastModified]);
        const existing = imported.current.get(key);
        if (existing) {
          duplicates++;
          placedId = existing;
        } else {
          try {
            const { original, ...photo } = await preparePhoto(file);
            const id = newId();
            imported.current.set(key, id);
            urls.current.add(photo.previewUrl);
            urls.current.add(photo.thumbnailUrl);
            additions[id] = { ...photo, name: file.name, source: original };
            placedId = id;
          } catch (error) {
            skipped++;
            lastError = error instanceof Error ? error.message : 'The JPEG could not be opened.';
          }
        }
        if ((index + 1) % 4 === 0) setImportProgress({ finished: index + 1, total: files.length });
      }
      const count = Object.keys(additions).length;
      if (count) setAssets((items) => ({ ...items, ...additions }));
      if (target && placedId) {
        assignPhoto(target.spreadId, target.frameId, placedId);
      } else if (target) {
        setNotice(lastError ?? 'The JPEG could not be opened.');
      } else {
        setNotice([
          `Imported ${count} ${count === 1 ? 'photo' : 'photos'}.`,
          duplicates ? `${duplicates} already in the filmstrip.` : '',
          skipped ? `${skipped} skipped. Choose JPEGs up to 50 MB each.` : '',
        ].filter(Boolean).join(' '));
      }
    } finally {
      importing.current = false;
      setImportProgress(null);
    }
  }, [assignPhoto]);

  const pickPhoto = useCallback((id: string) => {
    setPickedPhoto((current) => current === id ? null : id);
  }, []);

  const choosePhotos = useCallback(() => {
    if (!importing.current && !exportingBook.current) filesInput.current?.click();
  }, []);

  const chooseFolder = useCallback(() => {
    const input = folderInput.current;
    if (!input || importing.current || exportingBook.current) return;
    input.webkitdirectory = true;
    input.click();
  }, []);

  function togglePreview() {
    setPreview((current) => !current);
  }

  async function download() {
    if (importing.current || exportingBook.current) return;
    setNotice('');
    if (standalone) {
      setNotice('Open the studio through the local server to export a PDF.');
      return;
    }
    exportingBook.current = true;
    setExporting(true);
    try {
      if (await exportBook(spreads, assets)) setNotice('Book PDF exported.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The book PDF could not be exported.');
    } finally {
      exportingBook.current = false;
      setExporting(false);
    }
  }

  const onDesktopCommand = useEffectEvent((command: DesktopCommand) => {
    switch (command) {
      case 'import-photos': choosePhotos(); break;
      case 'import-folder': chooseFolder(); break;
      case 'preview': togglePreview(); break;
      case 'export-pdf': void download(); break;
    }
  });

  useEffect(() => {
    if (!isDesktop()) return;
    const handle = (event: Event) => onDesktopCommand((event as CustomEvent<DesktopCommand>).detail);
    window.addEventListener(desktopCommandEvent, handle);
    return () => window.removeEventListener(desktopCommandEvent, handle);
  }, []);

  function readSelection(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = '';
    void importPhotos(files);
  }

  return (
    <main className={`editor${preview ? ' preview-mode' : ''}`} onKeyDown={(event) => {
      if (event.key === 'Escape') setPickedPhoto(null);
    }}>
      <input ref={filesInput} type="file" accept={jpegAccept} multiple hidden aria-label="Choose photos"
        onChange={(event) => readSelection(event.currentTarget)} />
      <input ref={folderInput} type="file" multiple hidden aria-label="Choose a photo folder"
        onChange={(event) => readSelection(event.currentTarget)} />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Icon name="book" /></div>
          <div>
            <div className="brand-title">Senja <span>/</span> Photobook</div>
            <div className="brand-subtitle">FIELD NOTES  ·  BOOK STUDIO</div>
          </div>
        </div>
        <div className="top-actions">
          <span className="draft"><i /> Sample book</span>
          <button className="button ghost" type="button" aria-pressed={preview} onClick={togglePreview}>{preview ? 'Back to editor' : 'Preview'}</button>
          <button className="button primary" type="button" onClick={download} disabled={exporting || !!importProgress}>
            <Icon name="arrow" /> {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
        </div>
      </header>

      <div className="studio-body">
        {!preview && (
          <aside className="navigator" aria-label="Book spreads">
            <div className="rail-heading">
              <div><h2>Book</h2><p>{spreads.length * 2} pages · {spreads.length} spreads</p></div>
              <button className="icon-button" type="button" onClick={() => add(false)} aria-label="Add spread" title="Add spread" disabled={spreads.length >= maxSpreads}><Icon name="plus" /></button>
            </div>
            <div className="spread-list">
              {spreads.map((item, itemIndex) => (
                <button key={item.id} type="button" className="spread-card" aria-current={item.id === activeId ? 'true' : undefined} onClick={() => activate(item.id)}>
                  <div className="thumbnail"><SpreadArtwork spread={item} assets={assets} /></div>
                  <span className="spread-card-text"><strong>{item.name || 'Untitled spread'}</strong><small>{pageLabel(itemIndex)}</small></span>
                </button>
              ))}
            </div>
            <button className="add-spread" type="button" onClick={() => add(false)} disabled={spreads.length >= maxSpreads}><Icon name="plus" /> Add spread</button>
          </aside>
        )}

        <section className="workbench" aria-label="Spread workspace">
          <div className="workbench-header">
            <div>
              <div className="overline">SPREAD {String(index + 1).padStart(2, '0')} / {String(spreads.length).padStart(2, '0')}</div>
              <h1>{spread.name || 'Untitled spread'}</h1>
            </div>
            {!preview && (
              <div className="workbench-tools">
                <label className="guide-control"><input type="checkbox" checked={guides} onChange={(event) => setGuides(event.currentTarget.checked)} /> Guides</label>
                <button className="icon-button" type="button" aria-label="Duplicate spread" title="Duplicate spread" onClick={() => add(true)} disabled={spreads.length >= maxSpreads}><Icon name="copy" /></button>
                <button className="icon-button" type="button" aria-label="Delete spread" title="Delete spread" onClick={remove} disabled={spreads.length === 1}><Icon name="trash" /></button>
              </div>
            )}
          </div>
          <div className="desk">
            <div className="canvas-holder">
              <div className="paper" key={spread.id}>
                <SpreadArtwork
                  spread={spread}
                  assets={assets}
                  editing={preview ? undefined : {
                    selected: frameId, guides, select: selectFrame, movePhoto, placePhoto, updateText,
                    pickedPhoto, acceptingPhoto: !!(pickedPhoto || draggedPhoto),
                  }}
                />
                <div className="fold" aria-hidden="true" />
              </div>
              <div className="page-numbers"><span>{String(index * 2 + 1).padStart(2, '0')}</span><span>{String(index * 2 + 2).padStart(2, '0')}</span></div>
            </div>
          </div>
          <footer className="workbench-footer">
            <span>{preview ? 'Book preview' : 'Click text to edit it on the spread.'}</span>
            <div className="pagination">
              <button className="icon-button" type="button" onClick={() => activate(spreads[index - 1].id)} disabled={index === 0} aria-label="Previous spread"><Icon name="left" /></button>
              <span>{pageLabel(index)}</span>
              <button className="icon-button" type="button" onClick={() => activate(spreads[index + 1].id)} disabled={index === spreads.length - 1} aria-label="Next spread"><Icon name="right" /></button>
            </div>
          </footer>
        </section>

        {!preview && (
          <aside className="inspector" aria-label="Spread inspector">
            <div className="inspector-title"><h2>Inspector</h2></div>
            <div className="tabs" aria-label="Inspector views">
              <button type="button" aria-pressed={tab === 'layout'} onClick={() => setTab('layout')}>Layout</button>
              <button type="button" aria-pressed={tab === 'content'} onClick={() => { setTab('content'); if (!frameId) setFrameId(layout.frames[0].id); }}>Content</button>
            </div>
            {tab === 'layout' ? (
              <div className="inspector-body">
                <label className="field-label" htmlFor="spread-name">Spread name</label>
                <input id="spread-name" className="field" value={spread.name} maxLength={90} onChange={(event) => {
                  const name = event.currentTarget.value;
                  update(activeId, (current) => ({ ...current, name }));
                }} />
                <div className="order-actions">
                  <button type="button" disabled={index === 0} onClick={() => reorder(-1)}>Move earlier</button>
                  <button type="button" disabled={index === spreads.length - 1} onClick={() => reorder(1)}>Move later</button>
                </div>
                <h3 className="section-label">Spread layout</h3>
                <div className="layout-grid">
                  {(Object.keys(layouts) as LayoutId[]).map((id) => (
                    <button key={id} className="layout-card" type="button" aria-pressed={spread.layoutId === id} onClick={() => chooseLayout(id)}>
                      <LayoutIcon id={id} /><span>{layouts[id].name}</span>
                    </button>
                  ))}
                </div>
                <p className="hint">Switch layouts to try a different composition. Content stays with the spread.</p>
              </div>
            ) : (
              <div className="inspector-body">
                <label className="field-label" htmlFor="frame">Frame</label>
                <select id="frame" className="field" value={frameId ?? ''} onChange={(event) => selectFrame(event.currentTarget.value)}>
                  {layout.frames.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>

                {frame?.type === 'text' && (
                  <div className="content-fields">
                    <label className="field-label" htmlFor="text-style">Text style</label>
                    <select id="text-style" className="field" value={styleId} onChange={(event) => {
                      const style = event.currentTarget.value as StyleId;
                      update(activeId, (current) => ({ ...current, text: { ...current.text, [frame.id]: { value: '', ...current.text[frame.id], style } } }));
                    }}>
                      {(Object.keys(textStyles) as StyleId[]).map((id) => <option key={id} value={id}>{textStyles[id].name}</option>)}
                    </select>
                    <div className="style-sample" style={{ fontFamily: textStyles[styleId].font }}>Aa <span>{textStyles[styleId].name}</span></div>
                    <label className="field-label" htmlFor="alignment">Alignment</label>
                    <select id="alignment" className="field" value={text?.align ?? 'left'} onChange={(event) => {
                      const align = event.currentTarget.value as Alignment;
                      update(activeId, (current) => ({ ...current, text: { ...current.text, [frame.id]: { value: '', ...current.text[frame.id], align } } }));
                    }}>
                      <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </select>
                    {textOverflow && <p className="hint warning">Some text extends past this frame. Try a smaller style or shorten the copy.</p>}
                  </div>
                )}

                {frame?.type === 'photo' && (
                  <div className="content-fields">
                    <div className="asset-name"><Icon name="image" /><span>{asset?.name ?? 'Empty photo frame'}</span></div>
                    <input ref={uploadInput} type="file" accept={jpegAccept} hidden aria-label="Choose a JPEG" onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void importPhotos([file], { spreadId: activeId, frameId: frame.id });
                    }} />
                    <button className="button ghost full" type="button" disabled={exporting || !!importProgress} onClick={() => uploadInput.current?.click()}>
                      {importProgress ? 'Importing…' : asset ? 'Replace photo' : 'Choose JPEG'}
                    </button>
                    {photo && asset && crop && (
                      <>
                        <div className="zoom-label"><label className="field-label" htmlFor="zoom">Crop zoom</label><output htmlFor="zoom">{Math.round(photo.placement.zoom * 100)}%</output></div>
                        <input id="zoom" type="range" min="1" max="3" step="0.01" value={photo.placement.zoom} onChange={(event) => movePhoto(frame.id, {
                          centerX: crop.x + crop.width / 2,
                          centerY: crop.y + crop.height / 2,
                          zoom: Number(event.currentTarget.value),
                        })} />
                        <button className="reset" type="button" onClick={() => movePhoto(frame.id, centered)}>Reset crop</button>
                        <p className="hint">Drag or use the arrow keys to position the photo.</p>
                        <p className="resolution"><span>Effective resolution</span><strong>{ppi} PPI</strong></p>
                        {ppi !== undefined && ppi < 300 && <p className="hint">Below the 300 PPI print target.</p>}
                        <button className="reset remove-photo" type="button" onClick={() => update(activeId, (current) => {
                          const photos = { ...current.photos };
                          delete photos[frame.id];
                          return { ...current, photos };
                        })}>Remove from frame</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
      {!preview && (
        <Filmstrip
          assets={assets}
          usage={usage}
          selected={pickedPhoto}
          progress={importProgress}
          canPlace={canPlacePhoto}
          importDisabled={exporting || !!importProgress}
          choosePhotos={choosePhotos}
          chooseFolder={chooseFolder}
          selectPhoto={pickPhoto}
          dragPhoto={setDraggedPhoto}
        />
      )}
      <div className={`status${notice ? ' visible' : ''}`} role="status">{notice}</div>
    </main>
  );
}

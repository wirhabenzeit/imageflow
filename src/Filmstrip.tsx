import { memo, useRef } from 'react';
import type { ChangeEvent } from 'react';
import type { Assets } from './book';
import { jpegAccept, photoDragType } from './photo';

export type ImportProgress = { finished: number; total: number };

export const Filmstrip = memo(function Filmstrip({
  assets,
  usage,
  selected,
  progress,
  canPlace,
  importFiles,
  selectPhoto,
  dragPhoto,
}: {
  assets: Assets;
  usage: ReadonlyMap<string, number>;
  selected: string | null;
  progress: ImportProgress | null;
  canPlace: boolean;
  importFiles: (files: File[]) => void;
  selectPhoto: (id: string) => void;
  dragPhoto: (id: string | null) => void;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const photos = Object.entries(assets);
  const used = photos.filter(([id]) => usage.has(id)).length;

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length) importFiles(files);
  }

  return (
    <section className="filmstrip" aria-label="Photo filmstrip">
      <div className="filmstrip-header">
        <div className="filmstrip-title">
          <h2>Filmstrip</h2>
          <span>{photos.length} photos · {used} used</span>
        </div>
        <p className="filmstrip-hint" aria-live="polite">
          {progress ? `Importing photos · ${progress.finished} / ${progress.total}` :
            !canPlace ? 'Choose a layout with photo frames to place images.' :
            selected ? 'Select a photo frame to place the image.' :
            'Drag a photo onto a frame, or select a photo and then a frame.'}
        </p>
        <div className="filmstrip-actions">
          <input ref={filesInput} type="file" accept={jpegAccept} multiple hidden aria-label="Choose photos" onChange={pick} />
          <input ref={folderInput} type="file" multiple hidden aria-label="Choose a photo folder" onChange={pick} />
          <button className="button ghost" type="button" disabled={!!progress} onClick={() => filesInput.current?.click()}>Add photos</button>
          <button className="button ghost" type="button" disabled={!!progress} onClick={() => {
            const input = folderInput.current;
            if (input) {
              input.webkitdirectory = true;
              input.click();
            }
          }}>Import folder</button>
        </div>
      </div>
      <ul className="filmstrip-track">
        {photos.map(([id, asset]) => {
          const count = usage.get(id) ?? 0;
          const status = count ? `Used in ${count} ${count === 1 ? 'frame' : 'frames'}` : 'Unused';
          return (
            <li key={id}>
              <button
                type="button"
                className="film-photo"
                aria-label={`${asset.name} · ${status}`}
                aria-pressed={selected === id}
                title={`${asset.name} · ${status}`}
                draggable={canPlace}
                onClick={() => selectPhoto(id)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(photoDragType, id);
                  event.dataTransfer.effectAllowed = 'copy';
                  dragPhoto(id);
                }}
                onDragEnd={() => dragPhoto(null)}
              >
                <span className="film-thumb">
                  <img src={asset.thumbnailUrl ?? asset.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
                  {count > 0 && <span className="film-used" aria-hidden="true">✓{count > 1 ? ` ${count}` : ''}</span>}
                </span>
                <span className="film-name">{asset.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

import { memo } from 'react';
import type { Assets } from './book';
import { photoDragType } from './photo';

export type ImportProgress = { finished: number; total: number };

export const Filmstrip = memo(function Filmstrip({
  assets,
  usage,
  selected,
  progress,
  canPlace,
  importDisabled,
  choosePhotos,
  chooseFolder,
  selectPhoto,
  dragPhoto,
}: {
  assets: Assets;
  usage: ReadonlyMap<string, number>;
  selected: string | null;
  progress: ImportProgress | null;
  canPlace: boolean;
  importDisabled: boolean;
  choosePhotos: () => void;
  chooseFolder: () => void;
  selectPhoto: (id: string) => void;
  dragPhoto: (id: string | null) => void;
}) {
  const photos = Object.entries(assets);
  const used = photos.filter(([id]) => usage.has(id)).length;

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
          <button className="button ghost" type="button" disabled={importDisabled} onClick={choosePhotos}>Add photos</button>
          <button className="button ghost" type="button" disabled={importDisabled} onClick={chooseFolder}>Import folder</button>
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

import { memo, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { layouts, photoCrop, textStyles, trim } from './book';
import type { Assets, Frame, LayoutId, Spread } from './book';
import { layoutSpread, textAnchor } from './bookRender';
import { photoDragType } from './photo';
import { spreadHeight, spreadWidth } from './spread';
import type { Crop, Placement } from './spread';

type Editing = {
  selected: string | null;
  guides: boolean;
  select: (id: string) => void;
  movePhoto: (id: string, placement: Placement) => void;
  placePhoto: (id: string, assetId: string) => void;
  updateText: (id: string, value: string) => void;
  pickedPhoto: string | null;
  acceptingPhoto: boolean;
};

export const SpreadArtwork = memo(function SpreadArtwork({
  spread,
  assets,
  editing,
}: {
  spread: Spread;
  assets: Assets;
  editing?: Editing;
}) {
  const key = useId();
  const { frames } = layouts[spread.layoutId];
  const { paper, layers } = useMemo(() => layoutSpread(spread, assets), [spread, assets]);
  const drag = useRef<{ pointer: number; id: string; x: number; y: number; crop: Crop; zoom: number } | null>(null);
  const [dropFrame, setDropFrame] = useState<string | null>(null);
  const [focusedText, setFocusedText] = useState<string | null>(null);
  const half = spreadWidth / 2;

  function select(frame: Frame) {
    if (!editing) return;
    if (frame.type === 'photo' && editing.pickedPhoto) {
      editing.placePhoto(frame.id, editing.pickedPhoto);
    } else {
      editing.select(frame.id);
    }
  }

  function dragOver(event: DragEvent<SVGGElement>, frame: Frame) {
    if (!editing || !event.dataTransfer.types.includes(photoDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropFrame(frame.id);
  }

  function drop(event: DragEvent<SVGGElement>, frame: Frame) {
    if (!editing || !event.dataTransfer.types.includes(photoDragType)) return;
    event.preventDefault();
    setDropFrame(null);
    const assetId = event.dataTransfer.getData(photoDragType);
    if (assetId) editing.placePhoto(frame.id, assetId);
  }

  function start(event: PointerEvent<SVGGElement>, frame: Frame) {
    if (!editing || editing.pickedPhoto || event.button !== 0 || !event.isPrimary) return;
    editing.select(frame.id);
    const content = spread.photos[frame.id];
    const asset = content && assets[content.assetId];
    if (frame.type !== 'photo' || !content || !asset) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId, id: frame.id, x: event.clientX, y: event.clientY,
      crop: photoCrop(asset, frame, content.placement), zoom: content.placement.zoom,
    };
  }

  function move(event: PointerEvent<SVGGElement>, frame: Frame) {
    const from = drag.current;
    if (!editing || !from || from.pointer !== event.pointerId || from.id !== frame.id) return;
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    const dx = (event.clientX - from.x) * spreadWidth / box.width;
    const dy = (event.clientY - from.y) * spreadHeight / box.height;
    editing.movePhoto(frame.id, {
      centerX: from.crop.x + from.crop.width / 2 - dx * from.crop.width / frame.width,
      centerY: from.crop.y + from.crop.height / 2 - dy * from.crop.height / frame.height,
      zoom: from.zoom,
    });
  }

  function press(event: KeyboardEvent<SVGGElement>, frame: Frame) {
    if (!editing) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(frame);
      return;
    }
    if (frame.type !== 'photo') return;
    const content = spread.photos[frame.id];
    const asset = content && assets[content.assetId];
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
    };
    const direction = delta[event.key];
    if (!asset || !content || !direction) return;
    event.preventDefault();
    const crop = photoCrop(asset, frame, content.placement);
    const step = event.shiftKey ? 0.1 : 0.02;
    editing.select(frame.id);
    editing.movePhoto(frame.id, {
      centerX: crop.x + crop.width * (0.5 + direction[0] * step),
      centerY: crop.y + crop.height * (0.5 + direction[1] * step),
      zoom: content.placement.zoom,
    });
  }

  const artwork = (
    <svg
      className={editing ? 'spread-art editable' : 'spread-art'}
      viewBox={`0 0 ${spreadWidth} ${spreadHeight}`}
      aria-label={editing ? 'Editable book spread' : undefined}
      aria-hidden={editing ? undefined : true}
    >
      <defs>
        {frames.map((frame) => <clipPath key={frame.id} id={key + frame.id}><rect {...box(frame)} /></clipPath>)}
      </defs>
      <rect width={spreadWidth} height={spreadHeight} fill={paper} />
      {frames.map((frame) => {
        const layer = layers.find(({ id }) => id === frame.id);
        const dropTarget = editing && frame.type === 'photo';
        return (
          <g
            key={frame.id}
            className={dropTarget ? `canvas-frame photo${editing.acceptingPhoto ? ' drop-ready' : ''}${editing.acceptingPhoto && dropFrame === frame.id ? ' drop-over' : ''}` : undefined}
            role={dropTarget ? 'button' : undefined}
            tabIndex={dropTarget ? 0 : undefined}
            aria-label={dropTarget ? `Edit ${frame.label}` : undefined}
            aria-pressed={dropTarget ? editing.selected === frame.id : undefined}
            aria-hidden={frame.type === 'text' ? true : undefined}
            onClick={dropTarget ? () => select(frame) : undefined}
            onPointerDown={dropTarget ? (event) => start(event, frame) : undefined}
            onPointerMove={dropTarget ? (event) => move(event, frame) : undefined}
            onLostPointerCapture={dropTarget ? () => { drag.current = null; } : undefined}
            onKeyDown={dropTarget ? (event) => press(event, frame) : undefined}
            onDragOver={dropTarget ? (event) => dragOver(event, frame) : undefined}
            onDragLeave={dropTarget ? (event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropFrame(null);
            } : undefined}
            onDrop={dropTarget ? (event) => drop(event, frame) : undefined}
          >
            <g clipPath={`url(#${key + frame.id})`}>
              {layer?.type === 'photo' && (
                <image {...layer.image} href={assets[layer.assetId].previewUrl} preserveAspectRatio="none" />
              )}
              {layer?.type === 'text' && (!editing || focusedText !== frame.id) && (
                <text
                  fill={layer.style.color}
                  fontFamily={layer.style.font}
                  fontSize={layer.style.size}
                  textAnchor={({ left: 'start', center: 'middle', right: 'end' } as const)[layer.align]}
                >
                  {layer.lines.map((line, index) => (
                    <tspan
                      key={index}
                      x={textAnchor(layer.frame, layer.align)}
                      y={layer.frame.y + layer.style.size + index * layer.style.leading}
                    >{line}</tspan>
                  ))}
                </text>
              )}
              {!layer && editing && focusedText !== frame.id && (
                <>
                  <rect {...box(frame)} fill={frame.type === 'photo' ? '#e8e4d9' : 'transparent'} />
                  <text x={frame.x + frame.width / 2} y={frame.y + frame.height / 2 + 6}
                    textAnchor="middle" fontSize="21" fill="#716c60" fontFamily="system-ui">
                    {frame.type === 'photo' ? '＋ ' : ''}{frame.label}
                  </text>
                </>
              )}
            </g>
            {dropTarget && (
              <rect
                {...box(frame)}
                className="frame-hit"
                fill="transparent"
                stroke={editing.selected === frame.id ? '#c77b42' : !layer ? '#999284' : 'transparent'}
                strokeWidth={editing.selected === frame.id ? 3 : 1.5}
                strokeDasharray={!layer && editing.selected !== frame.id ? '9 6' : undefined}
              />
            )}
          </g>
        );
      })}
      {editing?.guides && (
        <g className="canvas-guides" fill="none" stroke="#3e473f" strokeWidth="1.4" strokeDasharray="9 7">
          <rect x={trim.bleed} y={trim.bleed} width={spreadWidth - 2 * trim.bleed} height={spreadHeight - 2 * trim.bleed} />
          <path d={`M${half},0 V${spreadHeight}`} />
        </g>
      )}
    </svg>
  );

  if (!editing) return artwork;
  return (
    <div className="spread-surface">
      {artwork}
      <div className="canvas-text-layer">
        {frames.map((frame) => {
          if (frame.type !== 'text') return null;
          const content = spread.text[frame.id];
          const style = textStyles[content?.style ?? frame.style];
          return (
            <textarea
              key={frame.id}
              className="canvas-text-input"
              aria-label={`Edit ${frame.label}`}
              data-selected={editing.selected === frame.id}
              data-empty={!content?.value.trim()}
              maxLength={1800}
              value={content?.value ?? ''}
              style={{
                left: `${frame.x / spreadWidth * 100}%`,
                top: `${frame.y / spreadHeight * 100}%`,
                width: `${frame.width / spreadWidth * 100}%`,
                height: `${frame.height / spreadHeight * 100}%`,
                fontFamily: style.font,
                fontSize: `${style.size / spreadWidth * 100}cqw`,
                lineHeight: style.leading / style.size,
                textAlign: content?.align ?? 'left',
                color: focusedText === frame.id ? style.color : 'transparent',
              }}
              onFocus={() => { setFocusedText(frame.id); editing.select(frame.id); }}
              onBlur={(event) => {
                event.currentTarget.scrollTop = 0;
                setFocusedText(null);
              }}
              onChange={(event) => editing.updateText(frame.id, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.nativeEvent.isComposing) event.currentTarget.blur();
              }}
            />
          );
        })}
      </div>
    </div>
  );
});

function box({ x, y, width, height }: Frame) {
  return { x, y, width, height };
}

export function LayoutIcon({ id }: { id: LayoutId }) {
  const half = spreadWidth / 2;
  return (
    <svg viewBox={`0 0 ${spreadWidth} ${spreadHeight}`} className="layout-icon" aria-hidden="true">
      <rect x="1" y="1" width={spreadWidth - 2} height={spreadHeight - 2} rx="22" fill="var(--layout-paper)" />
      {layouts[id].frames.map((frame) => frame.type === 'photo' ? (
        <rect key={frame.id} {...box(frame)} fill="var(--layout-photo)" />
      ) : (
        <path key={frame.id} d={`M${frame.x} ${frame.y + 24} h${frame.width * 0.84} m${-frame.width * 0.84} 54 h${frame.width * 0.58}`}
          stroke="var(--layout-ink)" strokeWidth="19" strokeLinecap="round" />
      ))}
      <path d={`M${half} 0 v${spreadHeight}`} stroke="var(--layout-ink)" strokeWidth="11" opacity=".55" />
    </svg>
  );
}

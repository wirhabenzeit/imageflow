import { imageRect, layouts, photoCrop, textLines, textStyles } from './book';
import type { Alignment, Assets, Rect, Spread, StyleId } from './book';

export type PhotoLayer = {
  type: 'photo';
  id: string;
  frame: Rect;
  image: Rect;
  assetId: string;
};
export type TextLayer = {
  type: 'text';
  id: string;
  frame: Rect;
  lines: string[];
  style: (typeof textStyles)[StyleId];
  align: Alignment;
  overflow: boolean;
};
export type Layer = PhotoLayer | TextLayer;
export type RenderSpread = { paper: string; layers: Layer[] };

let measureContext: CanvasRenderingContext2D | null | undefined;

export function layoutSpread(spread: Spread, assets: Assets): RenderSpread {
  const { frames, paper } = layouts[spread.layoutId];
  const layers: Layer[] = [];

  for (const frame of frames) {
    if (frame.type === 'photo') {
      const content = spread.photos[frame.id];
      const asset = content && assets[content.assetId];
      if (asset && content) {
        layers.push({
          type: 'photo',
          id: frame.id,
          frame,
          assetId: content.assetId,
          image: imageRect(frame, photoCrop(asset, frame, content.placement)),
        });
      }
      continue;
    }

    const content = spread.text[frame.id];
    if (!content?.value.trim()) continue;
    const styleId = content.style ?? frame.style;
    const style = textStyles[styleId];
    measureContext ??= document.createElement('canvas').getContext('2d');
    const context = measureContext;
    if (context) context.font = `${style.size}px "${style.font}"`;
    const { lines, overflow } = textLines(content.value, frame, styleId, (line) =>
      context?.measureText(line).width ?? line.length * style.size * 0.5,
    );
    layers.push({
      type: 'text',
      id: frame.id,
      frame,
      style,
      lines,
      align: content.align ?? 'left',
      overflow,
    });
  }

  return { paper, layers };
}

export function textAnchor(frame: Rect, align: Alignment) {
  if (align === 'center') return frame.x + frame.width / 2;
  return align === 'right' ? frame.x + frame.width : frame.x;
}

export async function exportBook(spreads: Spread[], assets: Assets) {
  const pages = spreads.map((spread) => layoutSpread(spread, assets));
  const assetIds = new Set(pages.flatMap(({ layers }) =>
    layers.flatMap((layer) => layer.type === 'photo' ? [layer.assetId] : []),
  ));
  const data = new FormData();
  data.set('book', JSON.stringify({ spreads: pages }));
  await Promise.all([...assetIds].map(async (id) => {
    const { source } = assets[id];
    if (typeof source !== 'string') {
      data.set(id, source, 'source.jpg');
      return;
    }
    const response = await fetch(source);
    if (!response.ok) throw new Error('A sample photo could not be loaded.');
    data.set(id, await response.blob(), 'sample.jpg');
  }));

  const response = await fetch('/api/book', { method: 'POST', body: data });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error ?? 'Start the local server to export a PDF.');
  }

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'senja-photobook.pdf';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

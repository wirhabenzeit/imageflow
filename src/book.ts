import { getCrop, layout, spreadHeight, spreadWidth } from './spread';
import type { Crop, Dimensions, Placement } from './spread';

export type Rect = { x: number; y: number; width: number; height: number };
type PhotoFrame = Rect & { id: string; type: 'photo'; label: string };
type TextFrame = Rect & { id: string; type: 'text'; label: string; style: StyleId };
export type Frame = PhotoFrame | TextFrame;
export type Alignment = 'left' | 'center' | 'right';

export const textStyles = {
  display: { name: 'Display', font: 'Georgia', nativeFont: 'Georgia', size: 90, leading: 99, color: '#272922' },
  heading: { name: 'Heading', font: 'Georgia', nativeFont: 'Georgia', size: 65, leading: 76, color: '#272922' },
  body: { name: 'Body', font: 'Georgia', nativeFont: 'Georgia', size: 28, leading: 43, color: '#4b4b40' },
  caption: { name: 'Caption', font: 'Helvetica Neue', nativeFont: 'HelveticaNeue', size: 19, leading: 28, color: '#5c5a4e' },
  label: { name: 'Label', font: 'Helvetica Neue', nativeFont: 'HelveticaNeue', size: 18, leading: 28, color: '#696553' },
} as const;

export type StyleId = keyof typeof textStyles;
export type TextContent = { value: string; style?: StyleId; align?: Alignment };
export type PhotoContent = { assetId: string; placement: Placement };
export type Asset = Dimensions & { name: string; previewUrl: string; thumbnailUrl?: string; source: File | string };
export type Assets = Record<string, Asset>;
export type Spread = {
  id: string;
  layoutId: LayoutId;
  name: string;
  photos: Partial<Record<string, PhotoContent>>;
  text: Partial<Record<string, TextContent>>;
};

const photo = (id: string, label: string, x: number, y: number, width: number, height: number): PhotoFrame => ({
  type: 'photo', id, label, x, y, width, height,
});
const text = (id: string, label: string, style: StyleId, x: number, y: number, width: number, height: number): TextFrame => ({
  type: 'text', id, label, style, x, y, width, height,
});

const half = spreadWidth / 2;
const paper = '#f6f2e8';
export const layouts = {
  story: {
    name: 'Photo & story',
    paper,
    frames: [
      photo('photo1', 'Full-page photo', 0, 0, half, spreadHeight),
      text('eyebrow', 'Chapter label', 'label', 966, 122, 618, 45),
      text('heading', 'Heading', 'heading', 962, 188, 630, 180),
      text('body', 'Story', 'body', 966, 384, 618, 289),
      text('caption', 'Date or location', 'caption', 966, 743, 618, 55),
    ],
  },
  panorama: {
    name: 'Full panorama',
    paper,
    frames: [photo('photo1', 'Panorama', 0, 0, spreadWidth, spreadHeight)],
  },
  gallery: {
    name: 'Photo grid',
    paper,
    frames: [
      photo('photo1', 'Left photo', 88, 84, 680, 668),
      photo('photo2', 'Upper right photo', 942, 84, 680, 318),
      photo('photo3', 'Lower right photo', 942, 434, 680, 318),
      text('caption', 'Caption', 'caption', 88, 773, 680, 48),
    ],
  },
  diptych: {
    name: 'Two photos',
    paper,
    frames: [
      photo('photo1', 'Left photo', 88, 111, 680, 600),
      photo('photo2', 'Right photo', 942, 111, 680, 600),
      text('caption', 'Left caption', 'caption', 88, 746, 680, 65),
      text('caption2', 'Right caption', 'caption', 942, 746, 680, 65),
    ],
  },
  title: {
    name: 'Title spread',
    paper,
    frames: [
      text('eyebrow', 'Series label', 'label', 118, 174, 640, 48),
      text('heading', 'Book title', 'display', 111, 250, 650, 230),
      text('caption', 'Subtitle', 'caption', 118, 541, 640, 65),
      photo('photo1', 'Title photo', half, 0, half, spreadHeight),
    ],
  },
  journal: {
    name: 'Text spread',
    paper,
    frames: [
      text('eyebrow', 'Chapter label', 'label', 110, 112, 635, 45),
      text('heading', 'Heading', 'heading', 107, 176, 635, 175),
      text('body', 'Left text', 'body', 110, 388, 625, 360),
      text('body2', 'Right text', 'body', 970, 185, 625, 570),
    ],
  },
} satisfies Record<string, { name: string; paper: string; frames: Frame[] }>;

export type LayoutId = keyof typeof layouts;

export function photoCrop(asset: Dimensions, frame: Rect, placement: Placement): Crop {
  return getCrop(asset, placement, frame.width / frame.height);
}

export function imageRect(frame: Rect, crop: Crop): Rect {
  const width = frame.width / crop.width;
  const height = frame.height / crop.height;
  return { x: frame.x - crop.x * width, y: frame.y - crop.y * height, width, height };
}

export function textLines(
  value: string,
  rect: Rect,
  styleId: StyleId,
  measure: (word: string) => number,
) {
  const style = textStyles[styleId];
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (line && measure(next) > rect.width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  const visible = Math.max(1, Math.floor((rect.height - style.size) / style.leading) + 1);
  return { lines: lines.slice(0, visible), overflow: lines.length > visible || lines.some((line) => measure(line) > rect.width) };
}

export function pageLabel(index: number) {
  return `Pages ${index * 2 + 1}–${index * 2 + 2}`;
}

export function photoUsage(spreads: Spread[]) {
  const counts = new Map<string, number>();
  for (const spread of spreads) {
    for (const frame of layouts[spread.layoutId].frames) {
      if (frame.type !== 'photo') continue;
      const assetId = spread.photos[frame.id]?.assetId;
      if (assetId) counts.set(assetId, (counts.get(assetId) ?? 0) + 1);
    }
  }
  return counts;
}

export const trim = layout;

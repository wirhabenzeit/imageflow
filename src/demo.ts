import segla from './assets/segla.jpg';
import cottage from './assets/cottage.jpg';
import shore from './assets/shore.jpg';
import light from './assets/light.jpg';
import type { Assets, Spread } from './book';
import { centered } from './spread';

const demo = {
  segla: { name: 'Segla ridge', url: segla },
  cottage: { name: 'A cottage at the fjord', url: cottage },
  shore: { name: 'Slate shore', url: shore },
  light: { name: 'Evening light', url: light },
};

export const demoAssets: Assets = Object.fromEntries(
  Object.entries(demo).map(([id, { name, url }]) => [
    id, { name, previewUrl: url, source: url, width: 768, height: 512 },
  ]),
);

const photo = (assetId: string) => ({ assetId, placement: centered });

export const demoSpreads: Spread[] = [
  {
    id: 'cover',
    name: 'North of the Arctic Circle',
    layoutId: 'title',
    photos: { photo1: photo('segla') },
    text: {
      eyebrow: { value: 'FIELD NOTES    /    01' },
      heading: { value: 'Senja' },
      caption: { value: 'Northern Norway  ·  September 2025' },
    },
  },
  {
    id: 'arrival',
    name: 'At the water’s edge',
    layoutId: 'story',
    photos: { photo1: photo('cottage') },
    text: {
      eyebrow: { value: '01    /    ARRIVAL' },
      heading: { value: 'At the water’s\nedge' },
      body: { value: 'The road narrowed as it followed the fjord. By the time we reached the last bend, the clouds had dropped low enough to hide the mountains, leaving just the water and a white house on the shore.' },
      caption: { value: 'Mefjordvær, Senja  ·  16 September' },
    },
  },
  {
    id: 'ridge',
    name: 'Along the ridge',
    layoutId: 'panorama',
    photos: { photo1: photo('segla') },
    text: {},
  },
  {
    id: 'coast',
    name: 'The quiet coast',
    layoutId: 'gallery',
    photos: { photo1: photo('shore'), photo2: photo('light'), photo3: photo('cottage') },
    text: { caption: { value: 'Along the coast  ·  Western Senja' } },
  },
];

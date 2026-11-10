export type Crop = { x: number; y: number; width: number; height: number };
export type Placement = { centerX: number; centerY: number; zoom: number };
export type Dimensions = { width: number; height: number };

export const centered: Placement = { centerX: 0.5, centerY: 0.5, zoom: 1 };

export function getCrop(photo: Dimensions, placement: Placement, frameAspect: number): Crop {
  const aspect = frameAspect / (photo.width / photo.height);
  const width = Math.min(1, aspect) / placement.zoom;
  const height = Math.min(1, 1 / aspect) / placement.zoom;

  return {
    x: Math.max(0, Math.min(1 - width, placement.centerX - width / 2)),
    y: Math.max(0, Math.min(1 - height, placement.centerY - height / 2)),
    width,
    height,
  };
}

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

// The placement that shows `crop`, with its centre clamped the way getCrop clamps it. Values are rounded so
// project.json stays readable.
export function placementOf(crop: Crop, zoom: number): Placement {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return { centerX: round(crop.x + crop.width / 2), centerY: round(crop.y + crop.height / 2), zoom: round(zoom) };
}
export const maxZoom = 20;

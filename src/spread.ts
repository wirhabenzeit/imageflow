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

type Cropped = { crops?: Record<string, Placement>; focus?: { centerX: number; centerY: number } };

// The crop a photo box shows in a layout: the layout's own, else a fill around the focus, else a centred fill.
export function placementIn(box: Cropped | undefined, layout: string): Placement {
  const own = box?.crops && Object.hasOwn(box.crops, layout) ? box.crops[layout] : undefined;
  return own ?? (box?.focus ? { ...box.focus, zoom: 1 } : centered);
}

// Sets a layout's crop; its centre becomes the focus other layouts without a crop fill around. A centred fill
// stores nothing: the layout falls back to it, and so do the others.
export function setPlacement(box: Cropped, layout: string, placement: Placement) {
  const { centerX, centerY, zoom } = placement;
  const crops = { ...box.crops };
  delete crops[layout];
  if (centerX === .5 && centerY === .5 && zoom === 1) delete box.focus;
  else {
    crops[layout] = placement;
    box.focus = { centerX, centerY };
  }
  if (Object.keys(crops).length) box.crops = crops;
  else delete box.crops;
}

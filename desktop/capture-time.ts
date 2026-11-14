import type { CaptureTime } from '../src/photo-metadata';

// The editor's photo date: the EXIF capture time (read by `captureMetadata`, see src/photo-metadata.ts) as camera
// wall time with its offset when known, or else an estimate from the file's modification time. Editor-only: it sorts
// and groups the photo views, and is never stored in photos.json or given to templates.
export type PhotoDate = { captured: string; capturedEstimated?: boolean };

/** The file-time estimate for a photo without an EXIF capture time, as an ISO instant. */
export function estimatedCapture(captured: CaptureTime | undefined, mtime: number) {
  return captured || !Number.isFinite(mtime) ? undefined : new Date(mtime).toISOString();
}

export function photoDate(photo: { captured?: CaptureTime; estimatedCapture?: string }): PhotoDate | undefined {
  if (photo.captured) return { captured: photo.captured.dateTime + (photo.captured.offset ?? '') };
  return photo.estimatedCapture ? { captured: photo.estimatedCapture, capturedEstimated: true } : undefined;
}

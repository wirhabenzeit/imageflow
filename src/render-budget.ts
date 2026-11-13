// Time budgets for rendering with <RenderedImage> pictures (ADR 0006), shared by the render frame and the jobs that
// wait for it, so the two never disagree. Each picture has its own drawing timeout, counted once it starts drawing;
// time spent queued behind other pictures is not held against it. A job waiting for a frame (a check, a preview, an
// export) therefore does not use a fixed deadline: it waits while the frame makes progress, and gives up only when
// nothing has started or finished for longer than one picture may take, plus time to load and lay out.
import type { RenderMode } from './rendered-image';

export const pictureTimeoutMs: Record<RenderMode, number> = { preview: 60_000, check: 60_000, export: 120_000 };
// Loading the book, laying out spreads and decoding photos, before and after the pictures.
export const renderSetupMs = 60_000;
/** How long a waiting job allows a frame to go without progress before it reports a timeout. */
export const renderIdleMs = (mode: RenderMode) => pictureTimeoutMs[mode] + renderSetupMs;

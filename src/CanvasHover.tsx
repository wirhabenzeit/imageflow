import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { BookGeometry } from './desktop';
import { targetKey } from './edit-targets';
import { animateReorder, reorderTiming } from './reorder-motion';
import type { ReorderOffset } from './reorder-motion';

// Pointer-only state stays beside the overlays instead of invalidating the editor and panels.
export function CanvasHover({ stage, geometry, selected, spread, editKey, cropping, locate, motion }: {
  stage: RefObject<HTMLDivElement | null>; geometry?: BookGeometry; selected: boolean; spread?: string;
  editKey?: string; cropping: boolean;
  locate: (event: { clientX: number; clientY: number }) => { sheet?: string; target?: BookGeometry['targets'][number] };
  motion?: { offsets: ReorderOffset[]; start: number };
}) {
  const [hover, setHover] = useState<{ sheet?: string; target?: string }>({});
  const nodes = useRef<HTMLDivElement>(null);
  const move = useEffectEvent((event: MouseEvent) => {
    const found = locate(event);
    const target = found.target && selected && found.sheet === spread ? targetKey(found.target) : undefined;
    setHover(current => current.sheet === found.sheet && current.target === target ? current : { sheet: found.sheet, target });
  });
  useEffect(() => {
    const node = stage.current;
    const moved = (event: MouseEvent) => move(event);
    const leave = () => setHover(current => current.sheet || current.target ? {} : current);
    node?.addEventListener('mousemove', moved);
    node?.addEventListener('mouseleave', leave);
    return () => { node?.removeEventListener('mousemove', moved); node?.removeEventListener('mouseleave', leave); };
  }, [stage]);
  const target = selected && hover.sheet === spread ? hover.target : undefined;
  const sheet = hover.sheet !== spread ? geometry?.sheets.find(item => item.spread === hover.sheet) : undefined;
  useLayoutEffect(() => {
    const node = stage.current;
    if (node) node.style.cursor = target ? 'pointer' : '';
    return () => { if (node) node.style.cursor = ''; };
  }, [stage, target]);
  useLayoutEffect(() => {
    if (!motion || performance.timeOrigin + performance.now() >= motion.start + reorderTiming.duration || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animations: Animation[] = [];
    for (const offset of motion.offsets) for (const node of nodes.current?.querySelectorAll<HTMLElement>('[data-canvas-spread="' + CSS.escape(offset.spread) + '"]') ?? []) {
      const animation = animateReorder(node, offset);
      animation.startTime = motion.start - performance.timeOrigin;
      animations.push(animation);
    }
    return () => animations.forEach(animation => animation.cancel());
  }, [motion, sheet, target, editKey, cropping, geometry]);
  return <div ref={nodes} style={{ display: 'contents' }} data-canvas-hover>
    {sheet && <div data-canvas-spread={sheet.spread} className="sheet-hover" aria-hidden="true"
      style={{ left: sheet.x, top: sheet.y, width: sheet.width, height: sheet.height }} />}
    {geometry?.targets.filter(item => !cropping && (targetKey(item) === target || targetKey(item) === editKey)).map(item =>
      <div key={targetKey(item)} data-canvas-spread={item.spread} aria-hidden="true"
        className={'edit-target' + (targetKey(item) === editKey ? ' active' : '')}
        style={{ left: item.x - 4, top: item.y - 3, width: item.width + 8, height: item.height + 6 }} />)}
  </div>;
}

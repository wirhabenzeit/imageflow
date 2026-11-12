import { useEffect, useRef, useState } from 'react';
import type { DragEvent, RefObject } from 'react';

export const spreadMime = 'application/x-imageflow-spread';
type Indicator = { target: number; top: number };

export function useSpreadReorder({ list, revision, enabled, canMove, move }: {
  list: RefObject<HTMLDivElement | null>; revision?: string; enabled: boolean;
  canMove: (id: string, target: number) => boolean; move: (id: string, target: number) => void;
}) {
  const session = useRef<{ id: string; revision?: string; x: number; y: number }>(undefined);
  const animation = useRef<number>(undefined);
  const [dragging, setDragging] = useState<string>();
  const [indicator, setIndicator] = useState<Indicator>();

  function stopScroll() {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
  }
  function end() {
    stopScroll();
    session.current = undefined;
    setDragging(undefined);
    setIndicator(undefined);
  }
  useEffect(() => {
    end();
    // Native dragend also fires for Escape and drops outside the window.
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      stopScroll();
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, [revision, enabled]);

  function destination(): Indicator | undefined {
    const active = session.current;
    const node = list.current;
    const scroll = node?.parentElement;
    if (!enabled || !active || active.revision !== revision || !node || !scroll) return;
    const bounds = scroll.getBoundingClientRect();
    if (active.x < bounds.left || active.x > bounds.right || active.y < bounds.top || active.y > bounds.bottom) return;
    const buttons = [...node.querySelectorAll<HTMLElement>('.spread-thumb')];
    const start = buttons.findIndex((button) => button.dataset.spread === active.id);
    if (start < 0) return;
    const rects = buttons.map((button) => button.getBoundingClientRect());
    let boundary = rects.findIndex((rect) => active.y < rect.top + rect.height / 2);
    if (boundary < 0) boundary = rects.length;
    const target = boundary > start ? boundary - 1 : boundary;
    if (!canMove(active.id, target)) return;
    const y = boundary === 0 ? rects[0].top : boundary === rects.length ? rects.at(-1)!.bottom :
      (rects[boundary - 1].bottom + rects[boundary].top) / 2;
    return { target, top: y - node.getBoundingClientRect().top };
  }
  function showDestination() {
    const next = destination();
    setIndicator((previous) => previous?.target === next?.target && previous?.top === next?.top ? previous : next);
    return next;
  }
  function scroll() {
    const active = session.current;
    const node = list.current?.parentElement;
    if (!active || !node || !enabled || active.revision !== revision) return;
    const bounds = node.getBoundingClientRect();
    const edge = Math.min(48, bounds.height / 3);
    const direction = active.y < bounds.top + edge ? -Math.min(1, (bounds.top + edge - active.y) / edge) :
      active.y > bounds.bottom - edge ? Math.min(1, (active.y - bounds.bottom + edge) / edge) : 0;
    // Keep scrolling even when the pointer is still. Scale speed by elapsed time for high-refresh displays.
    let previous: number | undefined;
    function tick(time: number) {
      if (!session.current || !node) return;
      node.scrollTop += direction * Math.min(32, previous === undefined ? 16 : time - previous) * .65;
      previous = time;
      showDestination();
      animation.current = requestAnimationFrame(tick);
    }
    if (direction) animation.current = requestAnimationFrame(tick);
  }
  function over(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes(spreadMime) || !session.current) return;
    stopScroll();
    session.current.x = event.clientX;
    session.current.y = event.clientY;
    const next = showDestination();
    event.preventDefault();
    event.dataTransfer.dropEffect = next ? 'move' : 'none';
    scroll();
  }
  return {
    dragging, indicator, end, over,
    start(event: DragEvent<HTMLElement>, id: string) {
      if (!enabled) { event.preventDefault(); return; }
      session.current = { id, revision, x: event.clientX, y: event.clientY };
      event.dataTransfer.setData(spreadMime, id);
      event.dataTransfer.effectAllowed = 'move';
      setDragging(id);
    },
    leave(event: DragEvent<HTMLElement>) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      stopScroll();
      setIndicator(undefined);
    },
    drop(event: DragEvent<HTMLElement>) {
      if (!event.dataTransfer.types.includes(spreadMime)) return;
      event.preventDefault();
      const active = session.current;
      if (active) { active.x = event.clientX; active.y = event.clientY; }
      const next = destination();
      end();
      if (active && next && event.dataTransfer.getData(spreadMime) === active.id) move(active.id, next.target);
    },
  };
}

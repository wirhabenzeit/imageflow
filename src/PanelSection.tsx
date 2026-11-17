import type { HTMLAttributes, ReactNode } from 'react';
import { useSectionOpen } from './panels';

// One collapsible section of either sidebar: the same header, disclosure arrow, spacing and separator on both sides.
// `id` remembers whether it is open; an owner that lays out around the section passes `state` from useSectionOpen.
export function PanelSection({ id, title, initiallyOpen = true, state, className, summaryProps, bodyClassName, children }: {
  id: string; title: ReactNode; initiallyOpen?: boolean; state?: readonly [boolean, (open: boolean) => void];
  className?: string; bodyClassName?: string; summaryProps?: HTMLAttributes<HTMLElement>; children: ReactNode;
}) {
  const own = useSectionOpen(id, initiallyOpen);
  const [open, setOpen] = state ?? own;
  return <details className={'panel-section' + (className ? ' ' + className : '')} open={open}
    onToggle={(event) => { if (event.currentTarget.open !== open) setOpen(event.currentTarget.open); }}>
    <summary {...summaryProps}>{title}</summary>
    <div className={'panel-section-body' + (bodyClassName ? ' ' + bodyClassName : '')}>{children}</div>
  </details>;
}

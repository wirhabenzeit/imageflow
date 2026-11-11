import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

// Small action lists use ordinary buttons, including Tab, plus arrow-key navigation.
export function ActionMenu({ label, className, disabled, children }: {
  label: ReactNode; className: string; disabled?: boolean; children: ReactNode;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const close = () => root.current?.removeAttribute('open');
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  function keys(event: KeyboardEvent<HTMLDetailsElement>) {
    const menu = root.current!;
    if (event.key === 'Escape' && menu.open) {
      event.preventDefault(); event.stopPropagation(); close(); menu.querySelector('summary')?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = menu.open;
      menu.open = true;
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const last = buttons.length - 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last :
        !wasOpen || at < 0 ? (event.key === 'ArrowUp' ? last : 0) :
          (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  if (disabled) return <div className={className}><button className="action-menu-trigger" disabled>{label}</button></div>;
  return <details ref={root} className={className} onKeyDown={keys}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
    <summary>{label}</summary>
    <div className="action-menu-choices" onClick={(event) => {
      if ((event.target as Element).closest('button:not(:disabled)')) close();
    }}>{children}</div>
  </details>;
}

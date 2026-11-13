import { Children, isValidElement } from 'react';
import type { ReactNode, MouseEvent, ReactElement } from 'react';
import type { PopupItem } from './desktop';

type Button = { children?: ReactNode; disabled?: boolean; title?: string; onClick?: (event: MouseEvent<HTMLButtonElement>) => void };
const text = (node: ReactNode): string => Children.toArray(node).map((item) => typeof item === 'string' || typeof item === 'number' ? String(item)
  : isValidElement<{ children?: ReactNode }>(item) ? text(item.props.children) : '').join('');

// The same declarative actions feed a native menu; callbacks and book data stay in the owning renderer.
export function ActionMenu({ label, className, disabled, children }: {
  label: ReactNode; className: string; disabled?: boolean; children: ReactNode;
}) {
  const actions: ReactElement<Button>[] = [];
  const items: PopupItem[] = [];
  function collect(nodes: ReactNode) {
    Children.forEach(nodes, (node) => {
      if (!isValidElement<Button>(node)) return;
      if (node.type === 'hr') items.push({ type: 'separator' });
      else if (node.type === 'button') {
        const id = String(actions.push(node) - 1);
        items.push({ id, label: text(node.props.children), enabled: !node.props.disabled, toolTip: node.props.title });
      } else collect(node.props.children);
    });
  }
  collect(children);
  async function open(event: MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    const selected = await window.imageflow?.popupMenu(items, { x: Math.round(rect.left), y: Math.round(rect.bottom) });
    if (selected !== null && selected !== undefined) actions[Number(selected)]?.props.onClick?.({ ...event, currentTarget: trigger, target: trigger });
  }
  return <div className={className}><button type="button" className="action-menu-trigger" disabled={disabled} aria-haspopup="menu"
    onClick={(event) => void open(event)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.currentTarget.click(); }
    }}>{label}</button></div>;
}

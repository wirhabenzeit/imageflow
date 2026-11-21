import { Children, isValidElement } from 'react';
import type { ReactNode, MouseEvent, ReactElement } from 'react';
import type { PopupItem } from './desktop';

type Button = { children?: ReactNode; disabled?: boolean; title?: string; onClick?: (event: MouseEvent<HTMLButtonElement>) => void };
const text = (node: ReactNode): string => Children.toArray(node).map((item) => typeof item === 'string' || typeof item === 'number' ? String(item)
  : isValidElement<{ children?: ReactNode }>(item) ? text(item.props.children) : '').join('');

// A submenu of an ActionMenu, with buttons and separators of its own. It renders nothing by itself.
export function Submenu(_: { label: string; disabled?: boolean; children?: ReactNode }) { return null; }

// The same declarative actions feed a native menu; callbacks and book data stay in the owning renderer.
export function ActionMenu({ label, className, disabled, children }: {
  label: ReactNode; className: string; disabled?: boolean; children: ReactNode;
}) {
  const actions: ReactElement<Button>[] = [];
  function collect(nodes: ReactNode, items: PopupItem[] = []) {
    Children.forEach(nodes, (node) => {
      if (!isValidElement<Button>(node)) return;
      if (node.type === 'hr') items.push({ type: 'separator' });
      else if (node.type === 'button') {
        const id = String(actions.push(node) - 1);
        items.push({ id, label: text(node.props.children), enabled: !node.props.disabled, toolTip: node.props.title });
      } else if (node.type === Submenu) {
        const { label, disabled } = node.props as { label: string; disabled?: boolean };
        items.push({ label, enabled: !disabled, submenu: collect(node.props.children) });
      } else collect(node.props.children, items);
    });
    return items;
  }
  const items = collect(children);
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

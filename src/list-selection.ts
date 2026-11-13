import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

// Native-style selection shared by document assets and the template library.
export function useListSelection(ids: string[], name: (id: string) => string, multiple = true) {
  useEffect(() => {
    const focus = () => document.documentElement.classList.toggle('window-inactive', !document.hasFocus());
    window.addEventListener('focus', focus); window.addEventListener('blur', focus); focus();
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', focus); };
  }, []);
  const [selection, setSelection] = useState<string[]>([]);
  const [focused, setFocused] = useState<string>();
  const anchor = useRef<string>(undefined);
  const search = useRef({ text: '', at: 0 });
  const selected = selection.filter((id) => ids.includes(id));
  function choose(id: string, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) {
    setFocused(id);
    if (multiple && event.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const [from, to] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((a, b) => a - b);
      setSelection(ids.slice(from, to + 1));
    } else {
      anchor.current = id;
      setSelection(multiple && (event.metaKey || event.ctrlKey) ? selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id] : [id]);
    }
  }
  function key(event: KeyboardEvent<HTMLElement>) {
    if (multiple && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); setSelection(ids); return;
    }
    const at = Math.max(0, ids.indexOf(focused ?? selected.at(-1) ?? ids[0]));
    let next: string | undefined;
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      next = ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, at + (event.key === 'ArrowUp' ? -1 : 1)))];
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = performance.now();
      search.current = { text: (now - search.current.at < 900 ? search.current.text : '') + event.key.toLocaleLowerCase(), at: now };
      next = [...ids.slice(at + 1), ...ids.slice(0, at + 1)].find((id) => name(id).toLocaleLowerCase().startsWith(search.current.text));
    }
    if (next) {
      event.preventDefault(); choose(next, { shiftKey: event.shiftKey });
      event.currentTarget.querySelector<HTMLElement>('[data-list-id="' + CSS.escape(next) + '"]')?.focus();
    }
  }
  return { selected, focused, choose, key, setSelection, context(id: string, event: MouseEvent) {
    event.preventDefault(); if (!selected.includes(id)) choose(id); return selected.includes(id) ? selected : [id];
  } };
}

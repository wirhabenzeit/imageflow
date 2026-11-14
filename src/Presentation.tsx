import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { BookFrame } from './BookFrame';
import { renderOrigin } from './desktop';
import type { ProjectSummary, TemplateInfo } from './desktop';
import { hasFacingPages } from './format';
import { presentationPage, presentationUnits } from './presentation-model';

export function Presentation({ summary, template, start, close }: {
  summary: ProjectSummary; template: TemplateInfo; start: string; close: (spread: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState({ spread: start, page: 0 });
  const [single, setSingle] = useState(false);
  const [bleed, setBleed] = useState(false);
  const [overview, setOverview] = useState(false);
  const [help, setHelp] = useState(false);
  const [digits, setDigits] = useState('');
  const [active, setActive] = useState(true);
  const [activity, setActivity] = useState(0);
  const [error, setError] = useState('');
  const units = useMemo(() => presentationUnits(summary.project.spreads, template, single), [summary.project.spreads, template, single]);
  const at = Math.max(0, units.findIndex((unit) => unit.spread === selected.spread && (!single || !selected.page || unit.pages.includes(selected.page))));
  const unit = units[at];
  const view = useMemo(() => unit && ({ spread: unit.spread, side: unit.side, bounds: bleed ? 'bleed' as const : 'trim' as const, overview }), [unit, bleed, overview]);
  const wake = () => { setActive(true); setActivity((value) => value + 1); };
  function choose(index: number) {
    const next = units[Math.max(0, Math.min(units.length - 1, index))];
    if (next) setSelected({ spread: next.spread, page: next.pages[0] ?? 0 });
    wake();
  }
  useEffect(() => { host.current?.focus(); void window.imageflow?.setPresentation(true); return () => { void window.imageflow?.setPresentation(false); }; }, []);
  useEffect(() => { const timer = setTimeout(() => setActive(false), 2000); return () => clearTimeout(timer); }, [activity]);
  const key = useEffectEvent((event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>) => {
    if (event.metaKey || event.ctrlKey) return;
    wake();
    if (event.key === 'Escape' || (event.shiftKey && event.key.toLowerCase() === 'w')) {
      if (help) setHelp(false); else if (overview) setOverview(false); else close(unit?.spread ?? start);
    } else if (/^\d$/.test(event.key)) setDigits((value) => (value + event.key).slice(-5));
    else if (event.key === 'Enter' && digits) {
      const index = presentationPage(units, Number(digits));
      if (index >= 0) choose(index);
      setDigits(''); setOverview(false);
    } else if (event.key === 'Enter' && overview) setOverview(false);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'Delete'].includes(event.key) || (event.key === ' ' && event.shiftKey)) choose(at - 1);
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) choose(at + 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(units.length - 1);
    else if (event.key.toLowerCase() === 'f' && hasFacingPages(template.format)) setSingle((value) => !value);
    else if (event.key.toLowerCase() === 'b') setBleed((value) => !value);
    else if (event.key.toLowerCase() === 'g') setOverview((value) => !value);
    else if (event.key === '?') setHelp((value) => !value);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      // Preserve the system Close Window shortcut and other native commands.
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); key(event);
    };
    const message = (event: MessageEvent) => {
      if (event.origin !== renderOrigin || ![...host.current?.querySelectorAll('iframe') ?? []].some((frame) => frame.contentWindow === event.source)) return;
      if (event.data?.type === 'present-key') key(event.data);
      if (event.data?.type === 'present-select' && units.some((unit) => unit.spread === event.data.spread)) {
        setSelected({ spread: event.data.spread, page: 0 }); setOverview(false); host.current?.focus();
      }
    };
    window.addEventListener('keydown', listener, true); window.addEventListener('message', message);
    return () => { window.removeEventListener('keydown', listener, true); window.removeEventListener('message', message); };
  }, [units]);
  const wheelAt = useRef(0);
  return <div ref={host} className={'presentation' + (overview ? ' presentation-overview' : '') + (!active && !help && !overview ? ' presentation-idle' : '')} role="dialog" aria-modal="true" aria-label="Book presentation" tabIndex={-1}
    onPointerMove={wake} onClick={(event) => {
      if (help || overview || (event.target as HTMLElement).closest('button')) return;
      choose(at + (event.clientX < innerWidth / 2 ? -1 : 1));
    }} onWheel={(event) => {
      if (overview || help || Math.abs(event.deltaX) < 25 || performance.now() - wheelAt.current < 500) return;
      wheelAt.current = performance.now(); choose(at + (event.deltaX > 0 ? 1 : -1));
    }}>
    {view && <BookFrame project={summary.id} view="present" title="Presentation artwork" presentation={view}
      onGeometry={() => {}} onStatus={(status) => setError(status.state === 'error' ? status.message : '')} />}
    {(!unit || error) && <p className="presentation-message">{error || 'This book has no spreads yet.'}</p>}
    <div className={'presentation-indicator' + (active || digits ? ' visible' : '')} aria-live="polite">
      {digits ? 'Go to page ' + digits + ' ↵' : unit ? (unit.pages.length > 1 ? 'pp. ' : 'p. ') + unit.label + ' · ' + (at + 1) + ' / ' + units.length : ''}
    </div>
    {(help || !unit || error) && <div className="presentation-help">
      <p>← / → · Space / Shift Space · Page Up / Down · Return: navigate</p>
      <p>Home / End: first / last · Page number + Return: go to page</p>
      {hasFacingPages(template.format) && <p>F: spreads / single pages</p>}
      <p>B: trim / bleed · G: overview · ?: shortcuts · Esc / Shift W: exit</p>
      <button onClick={() => close(unit?.spread ?? start)}>End Presentation</button>
    </div>}
  </div>;
}

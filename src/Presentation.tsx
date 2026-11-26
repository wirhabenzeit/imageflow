import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookFrame } from './BookFrame';
import { renderOrigin } from './desktop';
import type { ProjectSummary, TemplateInfo } from './desktop';
import { hasFacingPages } from './format';
import { presentationPage, presentationUnits, presentsCover } from './presentation-model';
import type { PresentationUnit } from './presentation-model';
import { coverInstance } from './project';
import { usePresentationZoom } from './usePresentationZoom';
import type { CoverResolution } from './cover';

export function Presentation({ summary, start, close }: {
  summary: ProjectSummary; start: string; close: (spread: string) => void;
}) {
  const [template, setTemplate] = useState<TemplateInfo>();
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
  const [ready, setReady] = useState(false);
  // A newer revision that failed to render while an earlier one is shown: the artwork stays, with a short notice.
  const [stale, setStale] = useState('');
  // Navigation uses messages after startup; keep the initial URL stable while choosing other spreads.
  const [query] = useState(() => new URLSearchParams({ spread: start }).toString());
  const cover = !!template && presentsCover(summary.project.cover, template);
  // The cover's sheet, once its frame has drawn it, to fit it to the screen.
  const [sheet, setSheet] = useState<Exclude<CoverResolution, { status: 'unavailable' }>['geometry']['sheet']>();
  const [coverError, setCoverError] = useState('');
  const units = useMemo(() => template ? presentationUnits(summary.project.spreads, template, single) : [], [summary.project.spreads, template, single]);
  // The cover comes first, before the content: a unit of its own, which the spreads' frame does not draw.
  const items = useMemo<PresentationUnit[]>(() => cover ? [{ spread: coverInstance, side: 'spread', pages: [], label: 'Cover' }, ...units] : units, [cover, units]);
  const at = Math.max(0, items.findIndex((unit) => unit.spread === selected.spread && (!single || !selected.page || !unit.pages.length || unit.pages.includes(selected.page))));
  const unit = items[at];
  const onCover = unit?.spread === coverInstance && !overview;
  // The spreads' frame keeps the content unit last shown while the cover is on screen.
  const spreadUnit = unit?.spread === coverInstance ? units[0] : unit;
  const view = useMemo(() => spreadUnit && ({ spread: spreadUnit.spread, side: spreadUnit.side, bounds: bleed ? 'bleed' as const : 'trim' as const, overview }), [spreadUnit, bleed, overview]);
  const wake = () => { setActive(true); setActivity((value) => value + 1); };
  function choose(index: number) {
    const next = items[Math.max(0, Math.min(items.length - 1, index))];
    if (next) setSelected({ spread: next.spread, page: next.pages[0] ?? 0 });
    wake();
  }
  // Zoom only enlarges the spread on screen, not the overview or behind the shortcuts, and never makes anything editable.
  const zoom = usePresentationZoom({ host, enabled: ready && !!unit && !overview && !help && !error,
    swipe: (direction) => choose(at + direction) });
  // Each spread opens whole, as does the artwork after the overview, the shortcuts or another frame (bleed, single pages).
  useLayoutEffect(() => { zoom.reset(); }, [unit?.spread, unit?.side, bleed, overview, help]);
  const zoomKey = useEffectEvent((key: string) => {
    wake();
    if (key === '0') zoom.reset();
    else if (!overview && !help) zoom.zoomBy(key === '-' ? 1 / 1.25 : 1.25);
  });
  function focusPresentation() {
    const node = host.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
  }
  useLayoutEffect(() => { focusPresentation(); }, [ready]);
  useEffect(() => {
    window.addEventListener('focus', focusPresentation);
    return () => window.removeEventListener('focus', focusPresentation);
  }, []);
  useEffect(() => { if (unit) void window.imageflow?.setPresentationSpread(unit.spread); }, [unit?.spread]);
  useEffect(() => { const timer = setTimeout(() => setActive(false), 2000); return () => clearTimeout(timer); }, [activity]);
  const key = useEffectEvent((event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>) => {
    if (event.metaKey || event.ctrlKey) return;
    wake();
    if (event.key === 'Escape' || (event.shiftKey && event.key.toLowerCase() === 'w')) {
      // Escape returns an enlarged spread to the whole first; the next one ends the presentation as before.
      if (help) setHelp(false); else if (overview) setOverview(false);
      else if (event.key === 'Escape' && zoom.zoomed) zoom.reset(); else close(unit?.spread ?? start);
    } else if (/^\d$/.test(event.key)) setDigits((value) => (value + event.key).slice(-5));
    else if (event.key === 'Enter' && digits) {
      const index = presentationPage(units, Number(digits));
      if (index >= 0) choose(index + items.length - units.length);
      setDigits(''); setOverview(false);
    } else if (event.key === 'Enter' && overview) setOverview(false);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'Delete'].includes(event.key) || (event.key === ' ' && event.shiftKey)) choose(at - 1);
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) choose(at + 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(items.length - 1);
    else if (event.key.toLowerCase() === 'f' && template && hasFacingPages(template.format)) setSingle((value) => !value);
    else if (event.key.toLowerCase() === 'b') setBleed((value) => !value);
    else if (event.key.toLowerCase() === 'g') setOverview((value) => !value);
    else if (event.key === '?') setHelp((value) => !value);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      // ⌘0 / ⌘+ / ⌘− zoom the presentation, as on the canvas; consumed so the editor's menu commands stay with the editor.
      if (event.metaKey && !event.ctrlKey && !event.altKey && ['0', '=', '+', '-'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation(); zoomKey(event.key); return;
      }
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
  return <div ref={host} className={'presentation' + (overview ? ' presentation-overview' : '') + (zoom.zoomed ? ' presentation-zoomed' : '') +
    (zoom.panning ? ' presentation-panning' : '') + (!active && !help && !overview ? ' presentation-idle' : '')} role="dialog" aria-modal="true" aria-label="Book presentation" tabIndex={-1}
    onPointerMove={wake} onClick={(event) => {
      // An enlarged spread takes clicks for panning, not for turning it by accident.
      if (help || overview || zoom.zoomed || (event.target as HTMLElement).closest('button')) return;
      choose(at + (event.clientX < innerWidth / 2 ? -1 : 1));
    }}>
    {/* The artwork, scaled as a whole while zoomed; the notices, indicator and shortcuts above it keep their size. */}
    <div className="presentation-stage" style={{ transform: zoom.transform }}>
      <BookFrame project={summary.id} view="present" query={query} title="Presentation artwork" presentation={view}
        onGeometry={() => {}} onStatus={(status) => {
          if (status.state === 'ready') { setReady(true); setError(''); setStale(''); setTemplate(status.template); }
          else if (ready) setStale(status.message);
          else setError(status.message);
        }} />
      {/* Above the spreads' frame, which stays ready for the first spread. */}
      {cover && <div className={'presentation-cover' + (onCover ? '' : ' presentation-cover-hidden')} aria-hidden={!onCover || undefined}>
        <div className="presentation-cover-sheet" style={sheet ? { aspectRatio: sheet.width / sheet.height,
          width: 'min(100%, calc((100vh - 48px) * ' + sheet.width / sheet.height + '))' } : { width: '100%', height: '100%' }}>
          <BookFrame project={summary.id} view="cover" title="Presentation cover artwork" onStatus={(status) => {
            if (status.state === 'ready') { setCoverError(''); if (status.cover) setSheet(status.cover.geometry.sheet); }
            else if (!sheet) setCoverError(status.message);
          }} />
        </div>
      </div>}
    </div>
    {!ready && !error && <p className="presentation-message" role="status">Preparing presentation…</p>}
    {((ready && !unit) || error) && <p className="presentation-message">{error || 'This book has no spreads yet.'}</p>}
    {onCover && coverError && !error && <p className="presentation-message">{coverError}</p>}
    {stale && <p className="presentation-notice" role="status" title={stale}>
      The latest changes could not be shown; this is the previous version. The book check lists the problem.</p>}
    <div className={'presentation-indicator' + (active || digits ? ' visible' : '')} aria-live="polite">
      {digits ? 'Go to page ' + digits + ' ↵' : unit ? (!unit.pages.length ? unit.label : (unit.pages.length > 1 ? 'pp. ' : 'p. ') + unit.label) + ' · ' + (at + 1) + ' / ' + items.length +
        (zoom.zoomed ? ' · ' + Math.round(zoom.scale * 100) + '%' : '') : ''}
    </div>
    {(help || (ready && !unit) || error) && <div className="presentation-help">
      <p>← / → · Space / Shift Space · Page Up / Down · Return: navigate</p>
      <p>Home / End: first / last · Page number + Return: go to page</p>
      {template && hasFacingPages(template.format) && <p>F: spreads / single pages</p>}
      <p>Pinch or ⌘+ / ⌘−: zoom · Scroll or drag: pan · ⌘0, double-click or Esc: whole spread</p>
      <p>B: trim / bleed · G: overview · ?: shortcuts · Esc / Shift W: exit</p>
      <button onClick={() => close(unit?.spread ?? start)}>End Presentation</button>
    </div>}
  </div>;
}

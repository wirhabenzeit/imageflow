import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { SourceBadge } from './SourceBadge';
import type { SourceOrigin } from './SourceBadge';
import { sourceColorNames, sourceColors } from './source-properties';
import type { PhotoFilter, SourceColor, SourcePropertySpec, SourceProviderProperties } from './source-properties';
import { clickStar, filterActive, filterChips, filterSourceLabel, setPlacement, setProperty, shownProviders, toggleColor, toggleSource } from './photo-filter';

/**
 * The Filter control of the Sources strip and of Manage Assets (ADR 0014, section 5): a button that opens a popover
 * of placement, Source pills and one section per provider, and the chips of what is set. The popover is no menu: it
 * stays open while filters are combined, so the list behind it filters live, and closes on a click outside or Escape.
 * The state belongs to the caller; every change goes through the pure helpers of photo-filter.ts.
 */

const origin = (source: string): SourceOrigin => source === 'package' || source === 'linked' || source === 'lightroom' || source === 'photos' ? source : 'other';

/** A chip of the bar: text after its sources' icons, its scope as tooltip and accessible name, and × removing it. */
export type ChipItem = { key: string; label: string; title: string; origins?: string[]; remove: () => void };
/** The chips of `filter` for `change`, plus `extra` ones of the caller's own sections. */
export function chipItems(filter: PhotoFilter, change: (filter: PhotoFilter) => void, providers: readonly SourceProviderProperties[], noun: string): ChipItem[] {
  return filterChips(filter, providers, noun).map(({ remove, ...chip }) => ({ ...chip, remove: () => change(remove(filter)) }));
}

export function FilterChips({ chips, className = 'filter-chips' }: { chips: readonly ChipItem[]; className?: string }) {
  if (!chips.length) return null;
  return <span className={className} role="group" aria-label="Active filters">
    {chips.map((chip) => <button key={chip.key} type="button" className="filter-chip" title={chip.title} aria-label={'Remove filter: ' + chip.title}
      onClick={chip.remove}>
      {chip.origins?.map((source) => <SourceBadge key={source} origin={origin(source)} className="filter-chip-origin" />)}
      <span className="filter-chip-label">{chip.label}</span><span className="filter-chip-remove" aria-hidden="true">×</span>
    </button>)}
  </span>;
}

type PopoverProps = {
  filter: PhotoFilter; change: (filter: PhotoFilter) => void;
  /** The distinct sources of what the list holds: the Source pills, shown from two on. */
  sources: readonly string[];
  /** The providers whose properties can be filtered here (none on the Texts tab). */
  providers: readonly string[];
  /** What the list holds, for the popover's name: `photos`, `texts`, `assets`. */
  noun: string;
  /** Sections of the caller's own before and after the shared ones (Manage Assets: Kind, Needs attention). */
  lead?: ReactNode; tail?: ReactNode;
  /** Whether a section of the caller's own is set, and how Clear Filters clears it. */
  extraActive?: boolean; clearExtra?: () => void;
  /** `down` where the control is at the top of a window. */
  direction?: 'up' | 'down';
};

export function FilterPopover({ filter, change, sources, providers, noun, lead, tail, extraActive = false, clearExtra, direction = 'up' }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const active = filterActive(filter) || extraActive;
  // Escape and Done hand the focus back to the button; a click elsewhere leaves it where the click put it.
  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    popover.current?.querySelector<HTMLElement>('[aria-checked="true"], button, input')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const sections = shownProviders(filter, providers);
  const mixed = sources.length > 1;
  return <div ref={wrapper} className="photo-filter">
    <button ref={trigger} type="button" className="action-menu-trigger photo-filter-trigger" data-active={active || undefined} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? id : undefined} aria-label={active ? 'Filter, filters active' : 'Filter'} onClick={() => setOpen(!open)}>
      Filter <Icon name="chevron" /></button>
    {open && <div ref={popover} id={id} className={'photo-filter-popover photo-filter-' + direction} role="dialog" aria-label={'Filter ' + noun}>
      {lead}
      <section className="pf-section" aria-label="Placement">
        <h3 className="pf-heading">Placement</h3>
        <Choice label="Placement" value={filter.placement ?? 'all'} options={[['all', 'All'], ['unused', 'Unused'], ['used', 'Used']]}
          choose={(value) => change(setPlacement(filter, value as PhotoFilter['placement']))} />
      </section>
      {mixed && <section className="pf-section" aria-labelledby={id + '-source'}>
        <h3 className="pf-heading" id={id + '-source'}>Source</h3>
        <div className="pf-pills">{sources.map((source) => <button key={source} type="button" className="pf-pill" aria-pressed={!!filter.sources?.includes(source)}
          onClick={() => change(toggleSource(filter, source))}><Decorative origin={origin(source)} />{filterSourceLabel(source)}</button>)}</div>
      </section>}
      {sections.map(({ provider, label, properties }) => {
        const set = properties.some((spec) => filter.properties?.[spec.id] !== undefined);
        return <section key={provider} className="pf-section pf-provider" aria-labelledby={id + '-' + provider} data-provider={provider}>
          <h3 className="pf-heading" id={id + '-' + provider}><Decorative origin={origin(provider)} />{label} photos</h3>
          {/* The scope is said where a filter can mislead: in a book of one source every photo is this provider's. */}
          {set && mixed && <p className="pf-note">Photos from other sources stay visible.</p>}
          {properties.map((spec) => <PropertyControl key={spec.id} labelId={id + '-' + spec.id} spec={spec} provider={label} filter={filter} change={change} />)}
        </section>;
      })}
      {tail}
      <footer className="pf-footer">
        <button type="button" disabled={!active} onClick={() => { change({}); clearExtra?.(); }}>Clear Filters</button>
        <button type="button" onClick={() => close(true)}>Done</button>
      </footer>
    </div>}
  </div>;
}

// The icon beside a text that names the source already, so it is not read out twice.
const Decorative = ({ origin }: { origin: SourceOrigin }) => <span className="pf-origin" aria-hidden="true"><SourceBadge origin={origin} /></span>;

/** A segmented choice of one value, as radio buttons. */
export function Choice({ label, value, options, choose }: { label: string; value: string; options: readonly (readonly [string, string])[]; choose: (value: string) => void }) {
  return <div className="pc-segmented pf-choice" role="radiogroup" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => choose(option)}>{text}</button>)}
  </div>;
}

/** The control a property's kind implies (ADR 0014, section 1): a star row, a toggle, one flag choice or colour swatches. */
function PropertyControl({ labelId, spec, provider, filter, change }: { labelId: string; spec: SourcePropertySpec; provider: string; filter: PhotoFilter; change: (filter: PhotoFilter) => void }) {
  const value = filter.properties?.[spec.id];
  if (spec.kind === 'stars') {
    const minimum = typeof value === 'number' ? value : 0;
    return <div className="pf-row"><span className="pf-label" id={labelId}>Rating</span>
      <div className="pf-stars" role="radiogroup" aria-labelledby={labelId}>
        {[1, 2, 3, 4, 5].map((stars) => {
          const text = stars + (stars === 1 ? ' star' : ' stars') + (stars < 5 ? ' or more' : '');
          return <button key={stars} type="button" role="radio" aria-checked={minimum === stars} data-filled={stars <= minimum || undefined}
            aria-label={text} title={minimum === stars ? text + ' · click again for any rating' : text} onClick={() => change(clickStar(filter, spec.id, stars))}>★</button>;
        })}
      </div></div>;
  }
  if (spec.kind === 'heart') return <label className="pc-switch pf-toggle"><input type="checkbox" checked={value === true}
    onChange={(event) => change(setProperty(filter, spec.id, event.target.checked ? true : undefined))} />Favorites only</label>;
  if (spec.kind === 'flag') return <div className="pf-row"><span className="pf-label">Flag</span>
    <Choice label={provider + ' flag'} value={typeof value === 'string' ? value : 'any'}
      options={[['any', 'Any'], ['pick', 'Picked'], ['not-reject', 'Not Rejected'], ['reject', 'Rejected']]}
      choose={(choice) => change(setProperty(filter, spec.id, choice === 'any' ? undefined : choice as 'pick' | 'reject' | 'not-reject'))} /></div>;
  const colors = Array.isArray(value) ? value as readonly SourceColor[] : [];
  return <div className="pf-row"><span className="pf-label" id={labelId}>Label</span>
    <div className="pf-colors" role="group" aria-labelledby={labelId}>
      {sourceColors.map((color) => <button key={color} type="button" className={'source-mark-color-' + color} aria-pressed={colors.includes(color)}
        aria-label={sourceColorNames[color] + ' label'} title={sourceColorNames[color]} onClick={() => change(toggleColor(filter, spec.id, color))} />)}
    </div></div>;
}

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export type ChoiceValue = string | number | boolean;
export type ChoiceOption<V extends ChoiceValue = ChoiceValue> = { value: V; label: string; disabled?: boolean };
export type ChoiceProps<V extends ChoiceValue = ChoiceValue> = {
  label: string;
  value: V | undefined;
  options: readonly ChoiceOption<V>[];
  onChange(value: V): void;
  disabled?: boolean;
  hideLabel?: boolean;
};

/** The option the arrow keys move to from `from`, skipping disabled ones and wrapping around; `from` when none. */
export function nextChoice(enabled: readonly boolean[], from: number, step: 1 | -1 | 'first' | 'last') {
  const count = enabled.length;
  if (step === 'first' || step === 'last') {
    const order = [...enabled.keys()];
    return (step === 'first' ? order : order.reverse()).find((index) => enabled[index]) ?? from;
  }
  for (let offset = 1; offset <= count; offset++) {
    const index = ((from + step * offset) % count + count) % count;
    if (enabled[index]) return index;
  }
  return from;
}

/**
 * Draws a row of options, or a menu while the row is wider than its place (UI-015): labels never wrap or shrink, so a
 * row that does not fit made the whole Inspector scroll sideways, with options out of sight. By measured width, as few
 * long labels can overflow and many short ones fit. `labels` names the options, so new ones are measured again.
 */
export function FittingChoice({ labels, row, menu }: { labels: string; row: ReactNode; menu: ReactNode }) {
  const place = useRef<HTMLDivElement>(null);
  // The width the row needs, while it is wider than its place. Hidden controls measure 0 and keep what they were.
  const [needed, setNeeded] = useState<{ labels: string; width: number }>();
  const width = needed?.labels === labels ? needed.width : undefined;
  useLayoutEffect(() => {
    const node = place.current;
    if (!node) return;
    const measure = () => {
      const drawn = node.firstElementChild as HTMLElement | null;
      if (width === undefined) {
        if (drawn && drawn.scrollWidth > drawn.clientWidth + 1) setNeeded({ labels, width: drawn.scrollWidth + drawn.offsetWidth - drawn.clientWidth });
      } else if (node.clientWidth >= width) setNeeded(undefined);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [labels, width]);
  return <div ref={place} className="pc-choice">{width === undefined ? row : menu}</div>;
}

/**
 * ImageFlow's own segmented choice, for custom element editors and layout-family pickers: the same control, colours,
 * selected, disabled and focus states, in light and dark, as the generated settings around it. A radio group: Tab
 * reaches the selected option, the arrow keys, Home and End choose another, and `label` names the group (shown above it
 * unless `hideLabel`). Options too wide for their place become a menu.
 */
export function Choice<V extends ChoiceValue>({ label, value, options, onChange, disabled = false, hideLabel = false }: ChoiceProps<V>) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((option) => !disabled && !option.disabled);
  const selected = options.findIndex((option) => option.value === value);
  const tabStop = selected >= 0 && enabled[selected] ? selected : enabled.indexOf(true);
  const key = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' }[event.key] as 1 | -1 | 'first' | 'last' | undefined;
    if (!step) return;
    event.preventDefault();
    const next = nextChoice(enabled, index, step);
    if (next === index) return;
    buttons.current[next]?.focus();
    onChange(options[next].value);
  };
  return <fieldset className="if-control if-choice" disabled={disabled}>
    <div className="field">
      {!hideLabel && <span className="field-name" id={id}>{label}</span>}
      <FittingChoice labels={options.map((option) => option.label).join('\n')} menu={
        <select {...hideLabel ? { 'aria-label': label } : { 'aria-labelledby': id }} value={selected < 0 ? '' : String(selected)}
          onChange={(event) => { const option = options[Number(event.target.value)]; if (event.target.value && option) onChange(option.value); }}>
          {selected < 0 && <option value="" hidden />}
          {options.map((option, index) => <option key={String(option.value)} value={String(index)} disabled={!enabled[index]}>{option.label}</option>)}
        </select>} row={<div className="pc-segmented" role="radiogroup" {...hideLabel ? { 'aria-label': label } : { 'aria-labelledby': id }}>
        {options.map((option, index) => <button key={String(option.value)} ref={(node) => { buttons.current[index] = node; }}
          type="button" role="radio" aria-checked={index === selected} disabled={!enabled[index]} tabIndex={index === tabStop ? 0 : -1}
          onKeyDown={(event) => key(event, index)} onClick={() => { if (index !== selected) onChange(option.value); }}>{option.label}</button>)}
      </div>} />
    </div>
  </fieldset>;
}

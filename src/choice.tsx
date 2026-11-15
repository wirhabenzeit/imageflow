import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';

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
 * ImageFlow's own segmented choice, for custom element editors and layout-family pickers: the same control, colours,
 * selected, disabled and focus states, in light and dark, as the generated settings around it. A radio group: Tab
 * reaches the selected option, the arrow keys, Home and End choose another, and `label` names the group (shown above it
 * unless `hideLabel`).
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
      <div className="pc-segmented" role="radiogroup" {...hideLabel ? { 'aria-label': label } : { 'aria-labelledby': id }}>
        {options.map((option, index) => <button key={String(option.value)} ref={(node) => { buttons.current[index] = node; }}
          type="button" role="radio" aria-checked={index === selected} disabled={!enabled[index]} tabIndex={index === tabStop ? 0 : -1}
          onKeyDown={(event) => key(event, index)} onClick={() => { if (index !== selected) onChange(option.value); }}>{option.label}</button>)}
      </div>
    </div>
  </fieldset>;
}

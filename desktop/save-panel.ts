import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { hidden } from './background-mode';
import { macHeader } from './mac-header';

export type SavePanelOptions = { title: string; buttonLabel: string; defaultPath: string; filter: { name: string; extension: string } };
/** The one option a save panel asks: a pop-up of choices, or a checkbox. The note explains it in smaller text. */
export type SavePanelControl<T> = { label: string; value: T; note?: string } &
  ([T] extends [boolean] ? { choices?: undefined } : { choices: { label: string; value: T }[] });

/**
 * A save sheet with an option in it (#274), or undefined when cancelled. Electron's save dialog cannot show one, so this
 * runs the panel of the native module. Hidden mode has no panel: it goes through `dialog.showSaveDialog`, which tests
 * replace, with the control among the options; a test's `value` answers it, and without one it keeps its first value.
 */
export async function showSavePanel<T extends boolean | number>(owner: BrowserWindow, options: SavePanelOptions, control: SavePanelControl<T>): Promise<{ filePath: string; value: T } | undefined> {
  const { title, buttonLabel, defaultPath, filter } = options;
  if (hidden || process.platform !== 'darwin') {
    const answer: { canceled: boolean; filePath?: string; value?: T } = await dialog.showSaveDialog(owner, { title, buttonLabel, defaultPath,
      filters: [{ name: filter.name, extensions: [filter.extension] }], ...{ control } });
    return answer.canceled || !answer.filePath ? undefined : { filePath: answer.filePath, value: answer.value ?? control.value };
  }
  const choices = control.choices as { label: string; value: T }[] | undefined;
  const answer = await macHeader().savePanel(owner.getNativeWindowHandle(), { defaultPath, extension: filter.extension, buttonLabel,
    label: control.label, note: control.note, options: choices?.map(({ label }) => label),
    value: choices ? choices.findIndex(({ value }) => value === control.value) : Number(control.value) });
  if (!answer) return undefined;
  return { filePath: answer.filePath, value: choices ? choices[answer.value].value : !!answer.value as T };
}

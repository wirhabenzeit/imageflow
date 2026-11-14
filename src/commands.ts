import type { BookMenuState } from './desktop';

type Spec = { label: string | ((state: BookMenuState) => string); accelerator?: string; registerAccelerator?: boolean; contextLabel?: string;
  enabled: (state: BookMenuState) => boolean; checked?: (state: BookMenuState) => boolean };
const book = (s: BookMenuState) => s.document && !s.busy;
const writable = (s: BookMenuState) => book(s) && s.writable;
const spread = (id: keyof BookMenuState['enabled']) => (s: BookMenuState) => writable(s) && !s.editing && !!s.enabled[id];
export const commandRegistry = {
  undo: { label: s => s.history?.undo ? 'Undo ' + s.history.undo : 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: s => writable(s) && !!s.history?.undo },
  redo: { label: s => s.history?.redo ? 'Redo ' + s.history.redo : 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', enabled: s => writable(s) && !!s.history?.redo },
  export: { label: 'Export PDF…', accelerator: 'CmdOrCtrl+E', enabled: s => book(s) && s.canExport },
  print: { label: 'Export for Print…', accelerator: 'CmdOrCtrl+Shift+E', enabled: s => book(s) && s.canPrint },
  'save-copy': { label: 'Duplicate…', accelerator: 'CmdOrCtrl+Shift+S', enabled: writable },
  'rename-book': { label: 'Rename…', enabled: writable },
  'move-book': { label: 'Move To…', enabled: writable },
  'revert-opened': { label: 'Last Opened', enabled: writable },
  'reveal-book': { label: 'Show in Finder', enabled: s => s.document },
  import: { label: 'Import…', accelerator: 'CmdOrCtrl+Shift+I', enabled: writable },
  'copy-assets': { label: 'Copy Assets into Book', enabled: writable, checked: s => s.importMode !== 'link' },
  'manage-sources': { label: 'Assets…', enabled: book },
  'add-spread': { label: 'New Spread', contextLabel: 'New Spread After', accelerator: 'CmdOrCtrl+Shift+N', enabled: spread('add-spread') },
  'duplicate-spread': { label: 'Duplicate Spread', accelerator: 'CmdOrCtrl+D', enabled: spread('duplicate-spread') },
  'delete-spread': { label: 'Delete Spread', accelerator: 'Backspace', registerAccelerator: false, enabled: spread('delete-spread') },
  'move-spread-start': { label: 'Move to Start', enabled: spread('move-spread-up') },
  'move-spread-end': { label: 'Move to End', enabled: spread('move-spread-down') },
  'move-spread-up': { label: 'Move Up', accelerator: 'Alt+CmdOrCtrl+Up', enabled: spread('move-spread-up') },
  'move-spread-down': { label: 'Move Down', accelerator: 'Alt+CmdOrCtrl+Down', enabled: spread('move-spread-down') },
  'book-check': { label: 'Check Book', accelerator: 'CmdOrCtrl+Shift+K', enabled: s => s.document },
  reload: { label: 'Reload from Disk', enabled: book },
  sidebar: { label: s => s.sidebar ? 'Hide Sidebar' : 'Show Sidebar', accelerator: 'Ctrl+Command+S', enabled: s => s.document },
  inspector: { label: s => s.inspector ? 'Hide Inspector' : 'Show Inspector', accelerator: 'Alt+CmdOrCtrl+I', enabled: s => s.document },
  sources: { label: s => s.sources ? 'Hide Sources' : 'Show Sources', accelerator: 'Alt+CmdOrCtrl+3', enabled: s => s.document },
  'layout-vertical': { label: 'Vertical', enabled: s => s.document, checked: s => s.layout?.mode !== 'grid' },
  'layout-grid': { label: 'Grid', enabled: s => s.document, checked: s => s.layout?.mode === 'grid' },
  'grid-columns': { label: 'Columns', enabled: s => s.document && s.layout?.mode === 'grid' },
  guides: { label: 'Show Guides', enabled: s => s.document, checked: s => !!s.guides },
  'zoom-in': { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', enabled: s => s.document && (s.zoom ?? 1) < 3 },
  'zoom-out': { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', enabled: s => s.document && (s.zoom ?? 1) > .3 },
  'zoom-actual': { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', enabled: s => s.document },
  presentation: { label: 'Presentation', contextLabel: 'Present from Here', accelerator: 'Shift+W', registerAccelerator: false, enabled: s => s.document },
  'presentation-start': { label: 'Present from Beginning', accelerator: 'Alt+Shift+W', registerAccelerator: false, enabled: s => s.document },
  'zoom-fit': { label: 'Zoom to Fit', enabled: s => s.document },
} satisfies Record<string, Spec>;
export type RegisteredCommand = keyof typeof commandRegistry;
export function commandState(id: RegisteredCommand, state: BookMenuState, context = false) {
  const spec: Spec = commandRegistry[id];
  return { id, label: context && spec.contextLabel ? spec.contextLabel : typeof spec.label === 'function' ? spec.label(state) : spec.label,
    accelerator: spec.accelerator, registerAccelerator: spec.registerAccelerator, enabled: spec.enabled(state), checked: spec.checked?.(state) };
}
export const emptyMenuState: BookMenuState = { document: false, writable: false, busy: false, editing: false, textEditing: false,
  canExport: false, canPrint: false, enabled: { 'add-spread': false, 'duplicate-spread': false, 'delete-spread': false, 'move-spread-up': false, 'move-spread-down': false } };

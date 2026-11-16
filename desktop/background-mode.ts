import { app, dialog } from 'electron';

export const hidden = !!process.env.IMAGEFLOW_HIDE_WINDOW;

// Tests exercising confirmations replace the dialog method explicitly. An unhandled prompt must fail
// instead of interrupting the person at the desktop or hanging until they dismiss it.
if (hidden) {
  for (const method of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync',
    'showSaveDialog', 'showSaveDialogSync', 'showErrorBox'] as const) {
    Object.assign(dialog, { [method]: (...args: unknown[]) => {
      const messages = args.flatMap((arg) => typeof arg === 'string' ? [arg] : arg && typeof arg === 'object'
        ? ['title', 'message', 'detail'].flatMap((key) => key in arg ? [String((arg as Record<string, unknown>)[key])] : []) : []);
      throw new Error('Unexpected native dialog in hidden mode (' + method + '): ' + messages.join(' '));
    } });
  }
  // Electron otherwise displays its own native error box for an uncaught main-process exception.
  process.on('uncaughtException', (error) => {
    console.error('ImageFlow hidden-mode exception:', error);
    app.exit(1);
  });
  // Accessory apps can create hidden windows without appearing (or bouncing) in the Dock.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
}

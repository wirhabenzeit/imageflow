export const desktopScheme = 'imageflow';
export const desktopCommandEvent = 'imageflow:command';
export type DesktopCommand = 'import-photos' | 'import-folder' | 'preview' | 'export-pdf';

export function isDesktop() {
  return window.location.protocol === desktopScheme + ':';
}

import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { UpdateNotice } from './UpdateNotice';
import './styles.css';

const root = document.getElementById('root')!;
const show = (view: ReactNode) => createRoot(root).render(<>{view}{window.location.pathname !== "/settings" && <UpdateNotice api={window.imageflow} />}</>);
if (window.location.hostname === 'render' && window.location.pathname.startsWith('/render/')) {
  void import('./render').then(({ startRender }) => startRender(root));
} else if (window.location.pathname === '/start') {
  void import('./StartWindow').then(({ StartWindow }) => show(<StartWindow api={window.imageflow} />));
} else if (window.location.pathname === '/new') {
  document.title = 'New Book';
  void import('./StarterPicker').then(({ StarterPicker }) => show(<StarterPicker api={window.imageflow} />));
} else if (window.location.pathname === '/markdown') {
  void import('./MarkdownWindow').then(({ MarkdownWindow }) => show(<MarkdownWindow api={window.imageflow} />));
} else if (window.location.pathname === '/presentation') {
  document.title = 'Presentation';
  void import('./PresentationWindow').then(({ PresentationWindow }) => createRoot(root).render(<PresentationWindow api={window.imageflow} />));
} else if (window.location.pathname === '/assets') {
  document.title = 'Assets';
  void import('./AssetsWindow').then(({ AssetsWindow }) => show(<AssetsWindow api={window.imageflow} />));
} else if (window.location.pathname === '/templates') {
  document.title = 'Templates';
  void import('./TemplateWindow').then(({ TemplateWindow }) => show(<TemplateWindow api={window.imageflow} />));
} else if (window.location.pathname === '/settings') {
  document.title = 'Settings';
  void import('./SettingsPanel').then(({ SettingsPanel }) => show(<SettingsPanel api={window.imageflow} />));
} else {
  void import('./App').then(({ App }) => show(<App />));
}

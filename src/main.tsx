import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root')!;
if (window.location.hostname === 'render' && window.location.pathname.startsWith('/render/')) {
  void import('./render').then(({ startRender }) => startRender(root));
} else if (window.location.pathname === '/start') {
  void import('./StartWindow').then(({ StartWindow }) => createRoot(root).render(<StartWindow api={window.imageflow} />));
} else if (window.location.pathname === '/new') {
  document.title = 'New Book';
  void import('./StarterPicker').then(({ StarterPicker }) => createRoot(root).render(<StarterPicker api={window.imageflow} />));
} else if (window.location.pathname === '/assets') {
  document.title = 'Assets';
  void import('./AssetsWindow').then(({ AssetsWindow }) => createRoot(root).render(<AssetsWindow api={window.imageflow} />));
} else if (window.location.pathname === '/templates') {
  document.title = 'Templates';
  void import('./TemplateWindow').then(({ TemplateWindow }) => createRoot(root).render(<TemplateWindow api={window.imageflow} />));
} else if (window.location.pathname === '/settings') {
  document.title = 'Settings';
  void import('./SettingsPanel').then(({ SettingsPanel }) => createRoot(root).render(<SettingsPanel api={window.imageflow} />));
} else {
  void import('./App').then(({ App }) => createRoot(root).render(<App />));
}

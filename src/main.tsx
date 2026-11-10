import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root')!;
if (window.location.hostname === 'render' && window.location.pathname.startsWith('/render/')) {
  void import('./render').then(({ startRender }) => startRender(root));
} else {
  void import('./App').then(({ App }) => createRoot(root).render(<App />));
}

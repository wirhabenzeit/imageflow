import { plainText } from './inline-text';
import type { Parameter } from './parameters';

/** Edits one occurrence in a private copy of its complete template spread. Ancestors, fonts and layout are retained;
 * the viewport is cropped to the node. This frame never writes project data or updates other occurrences. */
export function inlineTextFrame(root: HTMLElement, node: HTMLElement, param: Extract<Parameter, { type: 'string' }>,
  value: string, post: (data: unknown) => void, editorOrigin: string) {
  const sheet = node.closest<HTMLElement>('.if-sheet')!;
  const rect = node.getBoundingClientRect();
  const sheetRect = sheet.getBoundingClientRect();
  // Keep the full sheet's width: percentages, grid, inherited CSS and font sizing stay identical to the artwork.
  root.classList.add('if-inline-text-frame');
  sheet.style.position = 'absolute';
  sheet.style.left = -(rect.left - sheetRect.left) + 'px';
  sheet.style.top = -(rect.top - sheetRect.top) + 'px';
  node.dataset.textEditor = '';
  node.removeAttribute('data-empty');
  node.replaceChildren(document.createTextNode(value));
  // Chromium forces pre-wrap on plaintext-only regardless of author CSS. Use the normal editing surface with
  // plain-text input/paste guards so the page's own pre-line/normal/pre-wrap typography remains authoritative.
  node.contentEditable = 'true';
  node.setAttribute('role', 'textbox');
  node.setAttribute('aria-label', param.label);
  node.setAttribute('aria-multiline', String(!!param.multiline));
  node.spellcheck = true;
  let composing = false;
  let dirty = false;
  let pending: number | 'commit' | undefined;
  let inputWhitespace: { value: string; priority: string } | undefined;
  let restoreFrame = 0;
  const restoreWhitespace = () => {
    cancelAnimationFrame(restoreFrame);
    if (!inputWhitespace) return;
    const previous = inputWhitespace;
    inputWhitespace = undefined;
    if (previous.value) node.style.setProperty('white-space', previous.value, previous.priority);
    else node.style.removeProperty('white-space');
  };
  const prepareInput = () => {
    inputWhitespace ??= { value: node.style.getPropertyValue('white-space'), priority: node.style.getPropertyPriority('white-space') };
    node.style.setProperty('white-space', 'pre-wrap', 'important');
    // A cancelled composition can have no input event. Restore before the next paint in that case too.
    cancelAnimationFrame(restoreFrame);
    restoreFrame = requestAnimationFrame(restoreWhitespace);
  };
  const insertText = (text: string) => {
    prepareInput();
    try { document.execCommand('insertText', false, text); }
    finally { restoreWhitespace(); }
  };
  const values = () => {
    if (!dirty) return { [node.dataset.edit!]: value };
    // Chromium keeps a lone <br> as the caret container after deleting everything. It is not a saved newline.
    const empty = !node.textContent && node.childNodes.length <= 1;
    // innerText understands the browser's editable line containers, but also applies CSS text-transform and
    // whitespace collapse. Read without those display effects so styling never rewrites the saved string.
    const properties = ['text-transform', 'white-space'];
    const previous = properties.map((key) => [node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
    try {
      node.style.setProperty('text-transform', 'none', 'important');
      node.style.setProperty('white-space', 'pre-wrap', 'important');
      return { [node.dataset.edit!]: plainText(empty ? '' : node.innerText, !!param.multiline) };
    } finally {
      properties.forEach((key, i) => previous[i][0] ? node.style.setProperty(key, previous[i][0], previous[i][1]) : node.style.removeProperty(key));
    }
  };
  const measure = () => post({ type: 'text-size', height: Math.max(node.getBoundingClientRect().height, node.scrollHeight) });
  const draft = () => {
    post({ type: 'editor-draft', values: values() });
    queueMicrotask(measure);
  };
  const finish = (request?: number) => {
    if (composing) { pending = request ?? 'commit'; return; }
    post(request === undefined ? { type: 'editor-commit', values: values() } : { type: 'editor-flushed', request, values: values() });
  };
  node.addEventListener('compositionstart', () => { composing = true; });
  node.addEventListener('compositionend', () => {
    composing = false;
    draft();
    if (pending !== undefined) { const request = pending; pending = undefined; finish(request === 'commit' ? undefined : request); }
  });
  node.addEventListener('input', () => { restoreWhitespace(); dirty = true; draft(); });
  node.addEventListener('beforeinput', (event) => {
    if (event.inputType.startsWith('format') || event.inputType === 'insertFromDrop') { event.preventDefault(); return; }
    // Rich editable surfaces otherwise turn repeated typed spaces into NBSP. Preserve literal spaces in the
    // input operation, then restore the authored display before painting. Keep the browser's native Undo stack.
    prepareInput();
    if (event.isComposing || composing) return;
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      if (param.multiline) insertText('\n');
      else { restoreWhitespace(); finish(); }
    }
  });
  node.addEventListener('paste', (event) => {
    event.preventDefault();
    // insertText keeps the browser's typing Undo history, unlike replacing textContent on every input.
    insertText(plainText(event.clipboardData?.getData('text/plain') ?? '', !!param.multiline));
  });
  node.addEventListener('drop', (event) => { event.preventDefault(); });
  node.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ['b', 'i', 'u'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); post({ type: 'editor-cancel' }); }
    else if (event.key === 'Enter' && (!param.multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(); }
    else if (event.key === 'Tab') {
      event.preventDefault();
      post({ type: 'editor-step', direction: event.shiftKey ? -1 : 1, values: values() });
    }
  });
  // Leaving the frame flushes through the host's outside-click/Tab route. Do not also submit on DOM blur:
  // disabling the field or clicking Discard must not race a second commit against a failed save.
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== editorOrigin) return;
    if (event.data?.type === 'editor-flush') finish(event.data.request);
    else if (event.data?.type === 'text-disabled') node.contentEditable = event.data.disabled ? 'false' : 'true';
  });
  post({ type: 'editor-ready' });
  measure();
  node.focus({ preventScroll: true });
  // Select the saved text on activation, just as the generated parameter field does.
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

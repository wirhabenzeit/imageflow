// Flows HTML (from markdown.mjs) through a chain of fixed-size boxes. Runs in the page.
//
// Two strategies decide where a box's content ends:
//   "measure": lay the content out normally and find the first line below the box bottom,
//              then apply orphan, widow, and keep-with-next rules in JavaScript.
//   "columns": make the box a multi-column container of the same size and let Chrome's
//              fragmentation engine break the content; the break is the first character
//              that lands in an overflow column. CSS orphans/widows/break-* rules apply.
// Both then split the DOM at that character with Range.extractContents(), which clones
// partially selected ancestors, so inline formatting and list structure carry over.
(() => {
  const EPS = 0.5;
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6';
  const range = document.createRange();
  const isBlank = (node) => node.nodeType === Node.TEXT_NODE && !/\S/.test(node.data);

  function textIndex(root) {
    const nodes = [];
    const starts = [];
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node);
      starts.push(total);
      total += node.data.length;
    }
    return { nodes, starts, total };
  }

  function locate(index, i) {
    let lo = 0;
    let hi = index.nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.starts[mid] <= i) lo = mid; else hi = mid - 1;
    }
    return { node: index.nodes[lo], offset: i - index.starts[lo] };
  }

  const indexOf = (index, node) => index.starts[index.nodes.indexOf(node)];

  // Rectangle of the first visible character at or after i; collapsed whitespace has none.
  function charRect(index, i) {
    for (let j = i; j < Math.min(index.total, i + 400); j++) {
      const { node, offset } = locate(index, j);
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rects = range.getClientRects();
      if (rects.length && rects[0].height > 0) return rects[0];
    }
    return null;
  }

  // Smallest character index whose rectangle satisfies the predicate (monotonic in document order).
  function firstMatching(index, predicate) {
    let lo = 0;
    let hi = index.total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (predicate(charRect(index, mid))) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  // Groups client rects of a range into lines; returns line tops.
  function lineTops(startNode, startOffset, endNode, endOffset) {
    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    const rects = [...r.getClientRects()].filter((rect) => rect.height > 0).sort((a, b) => a.top - b.top);
    const tops = [];
    let bottom = -Infinity;
    for (const rect of rects) {
      if (rect.top >= bottom - 2) tops.push(rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return tops;
  }

  function firstText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (isBlank(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT),
    });
    return walker.nextNode();
  }

  const firstMeaningfulChild = (parent) => [...parent.childNodes].find((child) => !isBlank(child));

  function previousMeaningfulSibling(node) {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (!isBlank(sibling)) return sibling;
    }
    return null;
  }

  // Moves the split point up the tree while it sits at the start of its ancestors,
  // so that whole elements move instead of leaving empty shells behind.
  function splitPoint(root, index, p) {
    const { node, offset } = locate(index, p);
    if (isBlank(node)) return { before: node };
    if (offset > 0) return { node, offset };
    let element = node;
    while (element.parentNode !== root && firstMeaningfulChild(element.parentNode) === element) {
      element = element.parentNode;
    }
    return { before: element };
  }

  function hasContent(fragment) {
    return /\S/.test(fragment.textContent) || fragment.querySelector?.('hr,br');
  }

  function markContinuations(root, after) {
    const before = new Map();
    for (const element of root.querySelectorAll('[data-s]')) before.set(`${element.tagName}:${element.dataset.s}`, element);
    for (const element of after.querySelectorAll('[data-s]')) {
      const original = before.get(`${element.tagName}:${element.dataset.s}`);
      if (!original) continue;
      element.classList.add('cont');
      original.classList.add('split');
      if (element.tagName === 'OL') {
        const start = Number(original.getAttribute('start') ?? 1);
        const count = original.querySelectorAll(':scope > li').length;
        const first = element.querySelector(':scope > li');
        const continued = first && before.has(`LI:${first.dataset.s}`);
        element.setAttribute('start', String(start + count - (continued ? 1 : 0)));
      }
    }
  }

  function pruneTrailing(root) {
    while (root.lastChild && (isBlank(root.lastChild) ||
      (root.lastChild.nodeType === Node.ELEMENT_NODE && !/\S/.test(root.lastChild.textContent) && !root.lastChild.matches('hr')))) {
      root.lastChild.remove();
    }
  }

  function splitAt(root, index, p) {
    const point = splitPoint(root, index, p);
    const r = document.createRange();
    if (point.before) r.setStartBefore(point.before); else r.setStart(point.node, point.offset);
    r.setEnd(root, root.childNodes.length);
    const after = r.extractContents();
    markContinuations(root, after);
    pruneTrailing(root);
    return hasContent(after) ? after : null;
  }

  // ---- strategy "measure" ----

  function lineCount(block) {
    const start = firstText(block);
    const end = block.lastChild;
    if (!start || !end) return 0;
    return lineTops(start, 0, end, end.nodeType === Node.TEXT_NODE ? end.data.length : end.childNodes.length).length;
  }

  // Rectangle of exactly character i, or null for whitespace and invisible characters.
  function exactRect(index, i) {
    const { node, offset } = locate(index, i);
    if (!/\S/.test(node.data[offset] ?? '')) return null;
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getClientRects()[0];
    return rect && rect.height > 0 ? rect : null;
  }

  // Index of the first character on the line that ends just before p.
  function lineStartBefore(index, p) {
    let i = p - 1;
    let rect = null;
    while (i >= 0 && !(rect = exactRect(index, i))) i--;
    if (i < 0) return 0;
    let start = i;
    for (let j = i - 1; j >= 0; j--) {
      const r = exactRect(index, j);
      if (!r) continue;
      if (Math.abs(r.top - rect.top) > 2 || r.left > rect.left + 1) break;
      start = j;
    }
    return start;
  }

  function blockOf(box, index, p) {
    if (p >= index.total) return null;
    const { node } = locate(index, p);
    const block = node.parentElement?.closest(BLOCKS);
    if (!block || !box.contains(block)) return null;
    const start = firstText(block);
    return { block, start, blockStart: indexOf(index, start) };
  }

  // Orphans and keep-with-next, applied to a candidate break p.
  function applyRules(box, index, p) {
    const info = blockOf(box, index, p);
    if (!info) return p;
    let atStart = p <= info.blockStart;
    if (!atStart) {
      const { node, offset } = locate(index, p);
      if (lineTops(info.start, 0, node, offset).length < 2) {
        p = info.blockStart;
        atStart = true;
      }
    }
    if (atStart) {
      let anchor = info.block;
      while (anchor.parentNode !== box && firstMeaningfulChild(anchor.parentNode) === anchor) anchor = anchor.parentNode;
      const previous = anchor.parentNode === box ? previousMeaningfulSibling(anchor) : null;
      if (previous?.matches?.('h1,h2,h3,h4,h5,h6')) {
        const headingStart = indexOf(index, firstText(previous));
        if (headingStart > 0) p = headingStart;
      }
    }
    return p;
  }

  // Lays out the continued block at the next box's column width to count its lines there.
  function widowCheck(box, after, nextBox) {
    const cont = after.querySelector('p.cont, li.cont');
    if (!cont || !cont.contains(firstText(after))) return null;
    const original = box.querySelector(`${cont.tagName}.split[data-s="${cont.dataset.s}"]`);
    if (!original) return null;
    let top = cont;
    while (top.parentNode !== after) top = top.parentNode;
    const columns = Number(nextBox.dataset.columns ?? 1);
    const gap = parseFloat(getComputedStyle(nextBox).columnGap) || 0;
    const probe = document.createElement('div');
    probe.className = nextBox.className;
    probe.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;height:auto;width:${(nextBox.clientWidth - gap * (columns - 1)) / columns}px`;
    probe.append(top.cloneNode(true));
    document.body.append(probe);
    const linesAfter = lineCount(probe.querySelector(`${cont.tagName}.cont[data-s="${cont.dataset.s}"]`));
    probe.remove();
    return { linesBefore: lineCount(original), linesAfter };
  }

  // ---- candidate breaks ----

  // "measure": first character whose glyph box extends below the box.
  function measureBreak(box, index) {
    const limit = box.getBoundingClientRect().top + box.clientHeight + EPS;
    const p = firstMatching(index, (rect) => !rect || rect.bottom > limit);
    return p >= index.total ? null : p;
  }

  // "columns": first character that Chrome placed in an overflow column.
  function columnsBreak(box, index) {
    const boundary = box.getBoundingClientRect().left + box.clientWidth + EPS;
    const p = firstMatching(index, (rect) => !rect || rect.left > boundary);
    return p >= index.total ? null : p;
  }

  function overflows(box, strategy) {
    return box.scrollHeight > box.clientHeight + 1 || (strategy === 'columns' && box.scrollWidth > box.clientWidth + 1);
  }

  function fill(box, queue, strategy) {
    while (queue.firstChild && !overflows(box, strategy)) box.append(queue.firstChild);
    // One more block so that keep-with-next can look ahead.
    if (queue.firstChild) box.append(queue.firstChild);
  }

  function flowBox(box, queue, strategy, nextBox) {
    box.replaceChildren();
    if (strategy === 'columns') {
      const columns = Number(box.dataset.columns ?? 1);
      Object.assign(box.style, { columnCount: String(columns), columnFill: 'auto', overflow: 'hidden' });
    }
    fill(box, queue, strategy);
    if (!overflows(box, strategy)) return { retries: 0 };

    const snapshot = [...box.childNodes].map((node) => node.cloneNode(true));
    let index = textIndex(box);
    let p = strategy === 'columns' ? columnsBreak(box, index) : measureBreak(box, index);
    if (p === null) return { retries: 0, unresolved: true };
    const log = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      if (attempt > 0) {
        box.replaceChildren(...snapshot.map((node) => node.cloneNode(true)));
        index = textIndex(box);
      }
      p = applyRules(box, index, p);
      const lineBack = lineStartBefore(index, p);
      const block = blockOf(box, index, p);
      log.push({ p });
      const after = splitAt(box, index, p);
      if (overflows(box, strategy)) {
        // Line boxes can extend below glyph boxes (half-leading); retreat one line.
        log[log.length - 1].overflow = box.scrollHeight - box.clientHeight;
        p = lineBack;
        continue;
      }
      // Repeat until the continuation has at least two lines at the next box's width,
      // or move the whole block when only two lines would remain here.
      const widow = nextBox && after ? widowCheck(box, after, nextBox) : null;
      if (widow && widow.linesAfter < 2) {
        log[log.length - 1].widow = widow;
        if (widow.linesBefore >= 3) { p = lineBack; continue; }
        if (block && block.blockStart > 0 && p > block.blockStart) { p = block.blockStart; continue; }
      }
      if (after) queue.prepend(after);
      return { retries: attempt };
    }
    return { retries: 30, failed: true, log, height: box.clientHeight };
  }

  function run(html, boxes, strategy) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const queue = template.content;
    const started = performance.now();
    const results = boxes.map((box, i) => flowBox(box, queue, strategy, boxes[i + 1]));
    const elapsed = performance.now() - started;
    const overflowText = queue.textContent;
    return { elapsed, results, overflowText };
  }

  // ---- inspection helpers used by the harness ----

  function lines(box) {
    const index = textIndex(box);
    const boxRect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const columns = Number(style.columnCount) || 1;
    const gap = parseFloat(style.columnGap) || 0;
    const columnWidth = (box.clientWidth - gap * (columns - 1)) / columns;
    // Character by character, so that words broken across lines (long URLs) are attributed correctly.
    const words = [];
    for (const node of index.nodes) {
      for (let i = 0; i < node.data.length; i++) {
        if (!/\S/.test(node.data[i])) continue;
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const column = Math.max(0, Math.floor((rect.left - boxRect.left + 1) / (columnWidth + gap)));
        words.push({ text: node.data[i], column, top: rect.top, left: rect.left });
      }
    }
    words.sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left);
    const result = [];
    let current = null;
    for (const word of words) {
      if (!current || word.column !== current.column || word.top > current.top + 2) {
        current = { column: word.column, top: word.top, words: [] };
        result.push(current);
      }
      current.words.push(word.text);
    }
    return result.map((line) => line.words.join(''));
  }

  // Checks orphan, widow, and heading rules on the final layout.
  function ruleViolations(box) {
    const violations = [];
    const blocks = [...box.querySelectorAll(BLOCKS)].filter((block) => /\S/.test(block.textContent));
    const last = blocks[blocks.length - 1];
    const first = blocks[0];
    if (last?.classList.contains('split') && last.matches('p') && lineCount(last) < 2) violations.push('orphan');
    if (first?.classList.contains('cont') && first.matches('p') && lineCount(first) < 2) violations.push('widow');
    const lastTop = [...box.children].filter((child) => /\S/.test(child.textContent)).pop();
    if (lastTop?.matches('h1,h2,h3,h4,h5,h6')) violations.push('heading at end');
    return violations;
  }

  window.Flow = { run, lines, ruleViolations };
})();

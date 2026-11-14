// Gives every id under root a suffix and points the subtree's own references at the renamed ids: url(#id) in any
// attribute (clip-path, mask, fill, filter, style) and in <style> elements, href or xlink:href="#id", and #id
// selectors in <style> elements. References to ids outside root are left alone. Identifiers never contain '.', so a
// suffix such as '.p1' cannot turn one template id into another.
export function renameIds(root: Element, suffix: string) {
  const renamed = new Map<string, string>();
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    if (!node.id) continue;
    renamed.set(node.id, node.id + suffix);
    node.id += suffix;
  }
  if (!renamed.size) return;
  const lookup = (reference: string) => renamed.get(decoded(reference));
  const urls = (text: string) => text.replace(url, (whole, quote: string, id: string) => {
    const target = lookup(id);
    return target ? 'url(' + quote + '#' + target + quote + ')' : whole;
  });
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      const { name, value } = attribute;
      if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
        const target = lookup(value.slice(1));
        if (target) attribute.value = '#' + target;
      } else if (value.includes('url(')) {
        attribute.value = urls(value);
      }
    }
    if (node.localName === 'style' && node.textContent) {
      // Selectors are the text before each '{', except at-rule preludes; declarations (colours like #fff) are not touched.
      node.textContent = urls(node.textContent).replace(/([^{}]*)\{/g, (whole, prelude: string) => prelude.trimStart().startsWith('@') ? whole
        : prelude.replace(/#((?:\\.|[\w-])+)/g, (selector, id: string) => {
          const target = renamed.get(id.replace(/\\(.)/g, '$1'));
          return target ? '#' + target.replace(/[^\w-]/g, (char) => '\\' + char) : selector;
        }) + '{');
    }
  }
}

const url = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
// A malformed escape such as a bare '%' is matched as written instead of failing the export.
function decoded(reference: string) {
  try { return decodeURIComponent(reference); } catch { return reference; }
}

// Gives every id under root a suffix and points the subtree's own references at the renamed ids: url(#id) in any
// attribute (clip-path, mask, fill, filter, style) and href or xlink:href="#id". References to ids outside root are
// left alone.
export function renameIds(root: Element, suffix: string) {
  const renamed = new Map<string, string>();
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    if (!node.id) continue;
    renamed.set(node.id, node.id + suffix);
    node.id += suffix;
  }
  if (!renamed.size) return;
  const url = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      const { name, value } = attribute;
      if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
        const target = renamed.get(decodeURIComponent(value.slice(1)));
        if (target) attribute.value = '#' + target;
      } else if (value.includes('url(')) {
        attribute.value = value.replace(url, (whole, quote: string, id: string) => {
          const target = renamed.get(decodeURIComponent(id));
          return target ? 'url(' + quote + '#' + target + quote + ')' : whole;
        });
      }
    }
  }
}


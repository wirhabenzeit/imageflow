import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, RootContent, Root } from 'mdast';

function escape(text: string) {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

// Keep source offsets for the continuation engine from the text-flow spike.
export function markdownToHtml(source: string) {
  const root = fromMarkdown(source);
  const definitions = new Map<string, Definition>();
  function collect(node: Root | RootContent) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if ('children' in node) node.children.forEach(collect);
  }
  collect(root);

  function render(node: Root | RootContent, tight = false): string {
    const range = node.position ? ' data-s="' + node.position.start.offset + '" data-e="' + node.position.end.offset + '"' : '';
    const children = () => 'children' in node ? node.children.map((child) => render(child)).join('') : '';
    const wrap = (tag: string, html = children(), attrs = '') => '<' + tag + range + attrs + '>' + html + '</' + tag + '>';
    switch (node.type) {
      case 'root': return children();
      case 'paragraph': return tight ? children() : wrap('p');
      case 'heading': return wrap('h' + node.depth);
      case 'text': return escape(node.value);
      case 'emphasis': return wrap('em');
      case 'strong': return wrap('strong');
      case 'link':
      case 'linkReference': {
        const url = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
        return url && /^(https?:|mailto:)/i.test(url) ? wrap('a', children(), ' href="' + escape(url) + '"') : children();
      }
      case 'inlineCode': return wrap('code', escape(node.value));
      case 'break': return '<br>';
      case 'blockquote': return wrap('blockquote');
      case 'list': {
        const start = node.ordered && node.start != null ? ' start="' + node.start + '"' : '';
        const items = node.children.map((item) => render(item, !node.spread && !item.spread)).join('');
        return wrap(node.ordered ? 'ol' : 'ul', items, start);
      }
      case 'listItem': return wrap('li', node.children.map((child) => render(child, tight)).join(''));
      case 'thematicBreak': return '<hr' + range + '>';
      default: return '';
    }
  }
  return render(root);
}

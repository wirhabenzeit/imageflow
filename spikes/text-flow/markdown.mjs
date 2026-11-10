// Converts Markdown to HTML in which every element carries its source range (data-s, data-e).
// The fragmenter uses these attributes to recognize the two halves of a split element.
import { fromMarkdown } from 'mdast-util-from-markdown';

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const range = (node) => `data-s="${node.position.start.offset}" data-e="${node.position.end.offset}"`;

function render(node) {
  const children = () => (node.children ?? []).map(render).join('');
  switch (node.type) {
    case 'root': return children();
    case 'paragraph': return `<p ${range(node)}>${children()}</p>`;
    case 'heading': return `<h${node.depth} ${range(node)}>${children()}</h${node.depth}>`;
    case 'text': return escape(node.value);
    case 'emphasis': return `<em ${range(node)}>${children()}</em>`;
    case 'strong': return `<strong ${range(node)}>${children()}</strong>`;
    case 'link': return `<a ${range(node)} href="${escape(node.url)}">${children()}</a>`;
    case 'inlineCode': return `<code ${range(node)}>${escape(node.value)}</code>`;
    case 'break': return '<br>';
    case 'blockquote': return `<blockquote ${range(node)}>${children()}</blockquote>`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      return `<${tag} ${range(node)}${start}>${children()}</${tag}>`;
    }
    case 'listItem': {
      // Tight lists render their paragraphs inline, like CommonMark.
      const inner = node.spread ? children() : node.children.map((child) =>
        child.type === 'paragraph' ? child.children.map(render).join('') : render(child)).join('');
      return `<li ${range(node)}>${inner}</li>`;
    }
    case 'thematicBreak': return `<hr ${range(node)}>`;
    default: return `<!-- unsupported: ${node.type} -->`;
  }
}

export function markdownToHtml(source) {
  return render(fromMarkdown(source));
}

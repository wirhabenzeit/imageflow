import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, RootContent, Root } from 'mdast';
import { splitFrontmatter } from './frontmatter';

function escape(text: string) {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

// A top-level block of a Markdown source, as a template composes it (`MarkdownBox` children): what it is, its plain
// text, and its HTML as a whole (`html`) and without its own element (`content`).
export type MarkdownBlock = {
  type: 'paragraph' | 'heading' | 'blockquote' | 'list' | 'rule';
  depth?: 1 | 2 | 3 | 4 | 5 | 6;
  ordered?: boolean;
  text: string;
  start: number;
  html: string;
  content: string;
};

const blockTypes = { paragraph: 'paragraph', heading: 'heading', blockquote: 'blockquote', list: 'list', thematicBreak: 'rule' } as const;

function plain(node: Root | RootContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'break') return ' ';
  if (!('children' in node)) return '';
  const block = node.type === 'root' || node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem';
  return node.children.map(plain).filter((text) => !block || text).join(block ? '\n' : '');
}

export function markdownToHtml(source: string) {
  return markdownBlocks(source).map(({ html }) => html).join('');
}

// Keep source offsets for the continuation engine from the text-flow spike. A YAML header is not part of the text;
// it is blanked in place, so offsets still count from the start of the file.
export function markdownBlocks(source: string): MarkdownBlock[] {
  const root = fromMarkdown(splitFrontmatter(source).body);
  const definitions = new Map<string, Definition>();
  function collect(node: Root | RootContent) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if ('children' in node) node.children.forEach(collect);
  }
  collect(root);

  function render(node: Root | RootContent, tight = false, inner = false): string {
    const range = node.position ? ' data-s="' + node.position.start.offset + '" data-e="' + node.position.end.offset + '"' : '';
    const children = () => 'children' in node ? node.children.map((child) => render(child)).join('') : '';
    const wrap = (tag: string, html = children(), attrs = '') => inner ? html : '<' + tag + range + attrs + '>' + html + '</' + tag + '>';
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
      case 'thematicBreak': return inner ? '' : '<hr' + range + '>';
      default: return '';
    }
  }
  return root.children.flatMap((node): MarkdownBlock[] => {
    const type = blockTypes[node.type as keyof typeof blockTypes];
    if (!type) return [];
    return [{
      type, text: plain(node), start: node.position?.start.offset ?? 0, html: render(node), content: render(node, false, true),
      ...(node.type === 'heading' ? { depth: node.depth } : {}), ...(node.type === 'list' ? { ordered: !!node.ordered } : {}),
    }];
  });
}

// The flow's HTML for a composed text: what the template rendered, with each block's placeholder replaced by the
// block (`data-part="content"`: by its content alone). A placeholder is `<if-block data-i="3"></if-block>`.
export function composeHtml(staged: string, blocks: readonly MarkdownBlock[]) {
  return staged.replace(/<if-block\b([^>]*)><\/if-block>/g, (_, attributes: string) => {
    const block = blocks[Number(/\bdata-i="(\d+)"/.exec(attributes)?.[1] ?? -1)];
    return !block ? '' : /\bdata-part="content"/.test(attributes) ? block.content : block.html;
  });
}

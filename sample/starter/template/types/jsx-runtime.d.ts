// JSX types for ImageFlow templates. Templates render with React; this file stands in for React's types
// so a template folder type-checks without installing packages.
import type { CSSProperties, ImageFlowElement, ImageFlowNode } from './imageflow';

type Attributes = {
  className?: string;
  style?: CSSProperties;
  children?: ImageFlowNode;
  [attribute: string]: unknown;
};

export namespace JSX {
  type Element = ImageFlowElement;
  type ElementType = string | ((props: any) => ImageFlowNode);
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number | null }
  interface IntrinsicElements { [tag: string]: Attributes }
}
export function jsx(type: unknown, props: unknown, key?: unknown): ImageFlowElement;
export function jsxs(type: unknown, props: unknown, key?: unknown): ImageFlowElement;
export const Fragment: (props: { children?: ImageFlowNode }) => ImageFlowNode;

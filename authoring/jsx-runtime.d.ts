// JSX types for ImageFlow templates. Templates render with React; this file stands in for React's types
// so a template folder type-checks without installing packages.
import type { CSSProperties, ImageFlowElement, ImageFlowNode } from './imageflow';
import type * as ReactRuntime from './react-runtime/index';

type Attributes = {
  className?: string;
  style?: CSSProperties;
  children?: ImageFlowNode;
  [attribute: string]: unknown;
};

export namespace JSX {
  type Element = ImageFlowElement;
  // Template components, and React components from packages (memo, forwardRef, classes), which render with React too.
  type ElementType = string | ((props: any) => ImageFlowNode) | ReactRuntime.JSXElementConstructor<any>;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number | null }
  interface IntrinsicElements { [tag: string]: Attributes }
}
export function jsx(type: unknown, props: unknown, key?: unknown): ImageFlowElement;
export function jsxs(type: unknown, props: unknown, key?: unknown): ImageFlowElement;
export const Fragment: (props: { children?: ImageFlowNode }) => ImageFlowNode;

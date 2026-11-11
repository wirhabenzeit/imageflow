import type { ImageFlowNode, ImageFlowElement } from './imageflow';
import type * as ReactRuntime from './react-runtime/index';
export type { ImageFlowNode as ReactNode, ImageFlowElement as ReactElement, CSSProperties } from './imageflow';
export function createElement(type: string | ((props: any) => ImageFlowNode), props?: any, ...children: ImageFlowNode[]): ImageFlowElement;
export const Fragment: (props: { children?: ImageFlowNode }) => ImageFlowNode;
export const Children: {
  count(children: ImageFlowNode): number;
  toArray(children: ImageFlowNode): ImageFlowNode[];
  only(children: ImageFlowNode): ImageFlowElement;
  map<T>(children: ImageFlowNode, fn: (child: ImageFlowNode, index: number) => T): T[];
  forEach(children: ImageFlowNode, fn: (child: ImageFlowNode, index: number) => void): void;
};
declare const React: Omit<typeof ReactRuntime, 'createElement' | 'Fragment' | 'Children'> & {
  createElement: typeof createElement; Fragment: typeof Fragment; Children: typeof Children;
};
export default React;

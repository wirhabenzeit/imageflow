import type { ImageFlowNode, ImageFlowElement } from './imageflow';
import type * as ReactRuntime from './react-runtime/index';
export type { ImageFlowNode as ReactNode, ImageFlowElement as ReactElement, CSSProperties } from './imageflow';
// React's own types (components, refs, contexts, memo and forwardRef components, state), for packages whose declarations
// name them, such as React map components. ReactNode and ReactElement above stay the host's.
export type ComponentType<P = {}> = ReactRuntime.ComponentType<P>;
export type FC<P = {}> = ReactRuntime.FC<P>;
export type FunctionComponent<P = {}> = ReactRuntime.FunctionComponent<P>;
export type ElementType<P = any> = ReactRuntime.ElementType<P>;
export type JSXElementConstructor<P> = ReactRuntime.JSXElementConstructor<P>;
export type ComponentProps<T extends keyof ReactRuntime.JSX.IntrinsicElements | ReactRuntime.JSXElementConstructor<any>> = ReactRuntime.ComponentProps<T>;
export type ComponentPropsWithRef<T extends ReactRuntime.ElementType> = ReactRuntime.ComponentPropsWithRef<T>;
export type ComponentPropsWithoutRef<T extends ReactRuntime.ElementType> = ReactRuntime.ComponentPropsWithoutRef<T>;
export type PropsWithChildren<P = unknown> = ReactRuntime.PropsWithChildren<P>;
export type Key = ReactRuntime.Key;
export type Ref<T> = ReactRuntime.Ref<T>;
export type RefObject<T> = ReactRuntime.RefObject<T>;
export type RefCallback<T> = ReactRuntime.RefCallback<T>;
export type MutableRefObject<T> = ReactRuntime.MutableRefObject<T>;
export type RefAttributes<T> = ReactRuntime.RefAttributes<T>;
export type ExoticComponent<P = {}> = ReactRuntime.ExoticComponent<P>;
export type NamedExoticComponent<P = {}> = ReactRuntime.NamedExoticComponent<P>;
export type ForwardRefExoticComponent<P> = ReactRuntime.ForwardRefExoticComponent<P>;
export type MemoExoticComponent<T extends ReactRuntime.ComponentType<any>> = ReactRuntime.MemoExoticComponent<T>;
export type Context<T> = ReactRuntime.Context<T>;
export type Provider<T> = ReactRuntime.Provider<T>;
export type Consumer<T> = ReactRuntime.Consumer<T>;
export type Dispatch<A> = ReactRuntime.Dispatch<A>;
export type SetStateAction<S> = ReactRuntime.SetStateAction<S>;
export type HTMLAttributes<T> = ReactRuntime.HTMLAttributes<T>;
export type SVGProps<T> = ReactRuntime.SVGProps<T>;
export type DetailedHTMLProps<E extends ReactRuntime.HTMLAttributes<T>, T> = ReactRuntime.DetailedHTMLProps<E, T>;
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

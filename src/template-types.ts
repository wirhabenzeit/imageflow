// Compile-time check that the `imageflow` types shipped with the starter template match the runtime.
// `npm run build` fails here when one side changes without the other. Nothing in this file runs.
import type * as Declared from '../sample/starter/template/types/imageflow';
import type { PrintFormat, ResolvedFormat } from './format';
import type { Parameter } from './parameters';
import type { Photo } from './project';
import type { RenderContext, runtime } from './template';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assignable<A, B> = [A] extends [B] ? true : false;

export const declaredTypesMatchRuntime: [
  Same<keyof typeof Declared, keyof typeof runtime>,
  Assignable<Declared.PrintFormat, PrintFormat>,
  Same<Declared.Parameter['type'], Parameter['type']>,
  Same<keyof Declared.ResolvedFormat, keyof ResolvedFormat>,
  Same<keyof Declared.UntypedRenderContext, keyof RenderContext>,
  Same<keyof Declared.Photo, keyof Photo>,
] = [true, true, true, true, true, true];

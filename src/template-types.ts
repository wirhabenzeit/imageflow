// Compile-time check that the `imageflow` types shipped with the starter template match the runtime.
// `npm run build` fails here when one side changes without the other. Nothing in this file runs.
import type * as Declared from '../sample/starter/template/types/imageflow';
import type { PrintFormat, printFormat, ResolvedFormat } from './format';
import type { BoundGeometry } from './geometry';
import type { Parameter } from './parameters';
import type { Photo } from './project';
import type { Anchor, AnchorDeclaration, BookContext, Element, IssueMarker, MarkdownBox, PhotoBox, RenderContext, runtime, Spread, TemplateIssue,
  TemplateDeclaration, Text, TextTag } from './template';
import type { Capability, runtimeExports } from './runtime-exports';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assignable<A, B> = [A] extends [B] ? true : false;

export const declaredTypesMatchRuntime: [
  Same<keyof typeof Declared, keyof typeof runtime>,
  Assignable<Declared.PrintFormat, PrintFormat>,
  Same<Declared.Parameter['type'], Parameter['type']>,
  Same<keyof Declared.ResolvedFormat, keyof ResolvedFormat>,
  Same<keyof Declared.UntypedRenderContext, keyof RenderContext>,
  Same<keyof Declared.Photo, keyof Photo>,
  Same<Declared.Anchor, Anchor>,
  Same<Declared.AnchorDeclaration, AnchorDeclaration>,
  Same<keyof Declared.BookContext, keyof BookContext>,
  // The bundler exposes exactly the runtime's exports.
  Same<keyof typeof runtime, typeof runtimeExports[number]>,
  Same<Declared.TemplateIssue, TemplateIssue>,
  Same<Declared.IssueMarker, IssueMarker>,
  // Platform components accept the same props as declared, so attributes such as issue() markers are not dropped.
  Same<keyof Parameters<typeof Declared.Spread>[0], keyof Parameters<typeof Spread>[0]>,
  Same<keyof Parameters<typeof Declared.PhotoBox>[0], keyof Parameters<typeof PhotoBox>[0]>,
  Same<keyof Parameters<typeof Declared.MarkdownBox>[0], keyof Parameters<typeof MarkdownBox>[0]>,
  Same<keyof Parameters<typeof Declared.Element>[0], keyof Parameters<typeof Element>[0]>,
  Same<Declared.Capability, Capability>,
  Same<keyof Declared.TextProps, keyof Parameters<typeof Text>[0]>,
  Same<Declared.TextTag, TextTag>,
  Same<keyof Declared.BoundGeometry, keyof BoundGeometry>,
  Same<keyof Parameters<typeof Declared.printFormat>[0], keyof Parameters<typeof printFormat>[0]>,
  Assignable<ReturnType<typeof Declared.printFormat>, PrintFormat>,
  Same<keyof Declared.TemplateDeclaration, keyof TemplateDeclaration>,
  Assignable<Declared.OpeningSpread, NonNullable<TemplateDeclaration['openingSpreads']>[number]>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

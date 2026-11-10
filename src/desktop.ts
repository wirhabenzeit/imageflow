import type { PrintFormat, PrintSide, Span } from './format';
import type { Parameters } from './parameters';
import type { ProjectFiles } from './project';

export const desktopScheme = 'imageflow';
export const editorURL = desktopScheme + '://editor/';
export const renderOrigin = desktopScheme + '://render';

export const channels = {
  open: 'project:open', save: 'project:save', import: 'project:import',
  command: 'project:command', changed: 'project:changed',
  export: 'project:export', progress: 'project:progress', cancel: 'project:cancel',
} as const;

export type OpenAction = 'open' | 'new' | 'sample' | 'reload';
export type ExportMode = 'proof' | 'print';
export type Command = OpenAction | 'export' | 'print' | 'import-photos' | 'import-folder' | 'import-texts' | 'undo' | 'redo';
export type ProjectSummary = ProjectFiles & {
  id: string; folder: string; readOnly: boolean;
  photos: Record<string, string>;
};
export type Result<T> = { value: T } | { error: string };
export type ImportRequest = { kind: 'photo' | 'markdown'; paths?: string[]; folder?: boolean; target?: { spread: string; box: string } };

export type DesktopApi = {
  openProject(action: OpenAction): Promise<Result<ProjectSummary | null>>;
  saveProject(id: string, files: ProjectFiles): Promise<Result<ProjectSummary>>;
  importFiles(id: string, request: ImportRequest): Promise<Result<{ summary: ProjectSummary; imported: string[] } | null>>;
  pathsForFiles(files: File[]): string[];
  exportBook(id: string, mode: ExportMode): Promise<Result<{ warnings: Issue[] } | null>>;
  cancelExport(): Promise<void>;
  onCommand(listener: (command: Command) => void): () => void;
  onProjectChanged(listener: (result: Result<ProjectSummary>) => void): () => void;
  onProgress(listener: (stage: string) => void): () => void;
};

export type BoxDefinition = { type: 'photo' | 'markdown'; label: string; parameters: Parameters; flowOrder?: number };
export type SpreadDefinition = {
  label: string; span: Span; parameters: Parameters;
  boxes: Record<string, BoxDefinition>; elements: Record<string, { label: string; parameters: Parameters }>;
};
export type TemplateInfo = {
  version: string; format: PrintFormat; parameters: Parameters; spreads: Record<string, SpreadDefinition>;
};
export type BoxLocation = { id: string; type: 'photo' | 'markdown'; x: number; y: number; width: number; height: number };
// A preflight finding. `spread` is the spread id and `where` its readable location, such as "Pages 6–7 · Photo grid".
export type Issue = { message: string; spread?: string; where?: string };
export const issueText = ({ message, where }: Issue) => where ? where + ' · ' + message : message;
export type RenderStatus = {
  state: 'ready'; template: TemplateInfo; pages: number;
  units: { side: PrintSide; spread: string; where: string }[];
  errors: Issue[]; warnings: Issue[];
  flow: Record<string, { part: number; parts: number }>;
} | { state: 'error'; message: string; template?: TemplateInfo };

declare global {
  interface Window {
    imageflow?: DesktopApi;
    imageflowRenderStatus?: RenderStatus;
  }
}

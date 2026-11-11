import type { PrintFormat, PrintSide, Span } from './format';
import type { Parameters } from './parameters';
import type { ControlItem } from './controls';
import type { ProjectFiles } from './project';
import type { AuthoringCheckRequest, AuthoringCheckResult } from './authoring-check';
import type { AppSettings } from './settings';

export const desktopScheme = 'imageflow';
export const editorURL = desktopScheme + '://editor/';
export const settingsURL = desktopScheme + '://editor/settings';
export const renderOrigin = desktopScheme + '://render';

export const channels = {
  open: 'project:open', save: 'project:save', import: 'project:import',
  command: 'project:command', changed: 'project:changed',
  export: 'project:export', progress: 'project:progress', cancel: 'project:cancel',
  check: 'project:check', cancelCheck: 'project:cancel-check',
  panelVisibility: 'editor:panel-visibility',
  settings: 'app:settings', updateSettings: 'app:update-settings', settingsChanged: 'app:settings-changed',
  history: 'project:history', mcp: 'mcp:settings', mcpChanged: 'mcp:changed',
  agentLease: 'project:agent-lease', agentLeaseReply: 'project:agent-lease-reply', agentRelease: 'project:agent-release',
} as const;

export type OpenAction = 'open' | 'new' | 'sample' | 'reload';
export type ExportMode = 'proof' | 'print';
export type Command = OpenAction | 'agent-settings' | 'toggle-project' | 'toggle-inspector' | 'export' | 'print' | 'import-photos' | 'import-folder' | 'import-texts' | 'undo' | 'redo';
export type ProjectSummary = ProjectFiles & {
  id: string; folder: string; readOnly: boolean;
  handle?: string; history?: HistoryState;
  // Thumbnail URL and pixel size per readable photo; Markdown source per readable text.
  photos: Record<string, string>;
  photoSizes: Record<string, { width: number; height: number }>;
  texts: Record<string, string>;
};
export type Result<T> = { value: T } | { error: string };
export type HistoryState = { undo?: string; redo?: string };
export type McpSettings = { enabled: boolean; clients: { name: string }[]; config?: { command: string; args: string[] } };
export type ProjectChange = Result<ProjectSummary> | { building: true };
// `file` imports into the files/ registry for file parameters, offering the parameter's `accept` extensions.
export type ImportRequest = {
  kind: 'photo' | 'markdown' | 'file'; paths?: string[]; folder?: boolean; accept?: string[]; target?: { spread: string; box: string };
};

export type DesktopApi = {
  getSettings(): Promise<Result<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  setPanelVisibility(state: { sidebar: boolean; inspector: boolean }): Promise<void>;
  openProject(action: OpenAction): Promise<Result<ProjectSummary | null>>;
  saveProject(id: string, files: ProjectFiles, label?: string): Promise<Result<ProjectSummary>>;
  history(id: string, direction: 'undo' | 'redo'): Promise<Result<ProjectSummary>>;
  mcpSettings(enabled?: boolean): Promise<Result<McpSettings>>;
  onMcpChanged(listener: (settings: McpSettings) => void): () => void;
  onAgentLease(listener: (id: string) => boolean): () => void;
  onAgentRelease(listener: () => void): () => void;
  importFiles(id: string, request: ImportRequest): Promise<Result<{ summary: ProjectSummary; imported: string[] } | null>>;
  pathsForFiles(files: File[]): string[];
  exportBook(id: string, mode: ExportMode): Promise<Result<{ warnings: Issue[]; errors: Issue[] } | null>>;
  cancelExport(): Promise<void>;
  checkBook(id: string, request: AuthoringCheckRequest): Promise<Result<AuthoringCheckResult>>;
  cancelCheck(): Promise<void>;
  onCommand(listener: (command: Command) => void): () => void;
  onProjectChanged(listener: (result: ProjectChange) => void): () => void;
  onProgress(listener: (stage: string) => void): () => void;
};

// `editor` describes a template-supplied editor for some of the element's parameters (the component itself
// stays in the render frame).
// `controls` arranges the generated controls of a scope's parameters (src/controls.ts).
export type ElementDefinition = {
  label: string; parameters: Parameters; controls?: ControlItem[]; editor?: { label?: string; parameters: string[]; presentation: 'dialog' };
};
export type BoxDefinition = { type: 'photo' | 'markdown'; label: string; parameters: Parameters; flowOrder?: number; controls?: ControlItem[] };
export type SpreadDefinition = {
  label: string; span: Span; parameters: Parameters; controls?: ControlItem[];
  boxes: Record<string, BoxDefinition>; elements: Record<string, ElementDefinition>;
};
export type TemplateInfo = {
  version: string; parameters: Parameters; spreads: Record<string, SpreadDefinition>;
  // The format in use, its ID, and the labels of all formats the template offers.
  format: PrintFormat; formatId: string; formats: Record<string, string>;
};
export type BoxLocation = { id: string; type: 'photo' | 'markdown'; x: number; y: number; width: number; height: number };
// The editor shows the whole book in two frames: the scrolling spread view and the sidebar thumbnails.
// The layout picker renders one spread in every layout of the template.
export type BookView = 'book' | 'thumbs' | 'layouts';
export const bookLayout: Record<BookView, { pad: number; gap: number; columns?: number; columnGap?: number }> = {
  book: { pad: 32, gap: 40 },
  thumbs: { pad: 12, gap: 34 },
  layouts: { pad: 6, gap: 26, columns: 2, columnGap: 12 },
};
export type Rect = { x: number; y: number; width: number; height: number };
// Posted by a book frame after layout. Coordinates are relative to the frame document.
export type BookGeometry = {
  type: 'geometry'; height: number;
  sheets: (Rect & { spread: string })[];
  // `upright` is false when template CSS rotates or skews the box, so its rectangle is only a bounding box.
  boxes: (Rect & { spread: string; id: string; type: BoxLocation['type'] | 'element'; upright: boolean })[];
  // Nodes a template marked with `ctx.edit(...)`, and elements with parameters.
  targets: (Rect & { spread: string; edits: string[] })[];
};
// A preflight finding. `spread` is the spread id and `where` its readable location, such as "Pages 6–7 · Photo grid".
// The optional fields give agents a stable `code`, the box/element/source involved, measured values and a repair hint.
export type Issue = {
  message: string; spread?: string; where?: string;
  code?: string; box?: string; element?: string; source?: string; parameter?: string;
  details?: Record<string, string | number>; suggestion?: string;
};
export const issueText = ({ message, where }: Issue) => where ? where + ' · ' + message : message;
export type RenderStatus = {
  state: 'ready'; template: TemplateInfo; pages: number;
  units: { side: PrintSide; spread: string; where: string }[];
  errors: Issue[]; warnings: Issue[];
  flow: Record<string, { part: number; parts: number; title?: string }>;
  // Anchors the layouts declare, with the page each resolves to, in page order.
  anchors: { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' }[];
  inspection?: import('./inspection').ElementInspection;
} | {
  state: 'error'; message: string; template?: TemplateInfo;
  // Spreads whose layout threw or rendered no single <Spread> root, with the stack where template code threw.
  layoutFailures?: LayoutFailure[];
  // Declarations that violate the template contract, by path such as `spreads.chapter.parameters.heading.default`.
  declarationIssues?: { path: string; message: string }[];
  // Stack of any other failure, such as template module code that throws when imported.
  stack?: string;
};
export type LayoutFailure = { spread: string; message: string; stack?: string };

declare global {
  interface Window {
    imageflow?: DesktopApi;
    imageflowRenderStatus?: RenderStatus;
  }
}

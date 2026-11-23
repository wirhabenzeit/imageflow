import type { ProvidedMetadata } from './asset-facts';
import type { PhotoView, PhotoViewCommand } from './photo-view';
import type { PrintFormat, PrintSide, Span } from './format';
import type { Parameters } from './parameters';
import type { ControlItem } from './controls';
import type { PageSide, ProjectFiles, Values } from './project';
import type { AuthoringCheckRequest, AuthoringCheckResult } from './authoring-check';
import type { ImportMode, SourceStatus } from './source-locations';
import type { AppSettings, ICloudSyncBackend, S3SyncBackend, SettingsPane } from './settings';
import type { LibraryEntry, LibraryImportResult, NewBookChoice } from './library';
import type { CoverFormat, CoverResolution } from './cover';

export const desktopScheme = 'imageflow';
export const editorURL = desktopScheme + '://editor/';
export const startURL = desktopScheme + '://editor/start';
export const starterURL = desktopScheme + '://editor/new';
export const markdownURL = desktopScheme + '://editor/markdown';
export const presentationURL = desktopScheme + '://editor/presentation';
export const assetsURL = desktopScheme + '://editor/assets';
export const templatesURL = desktopScheme + '://editor/templates';
export const settingsURL = desktopScheme + '://editor/settings';
export const renderOrigin = desktopScheme + '://render';
// The sidebar thumbnails render the whole book too. From their own origin they get their own render process, so they
// render alongside the book view instead of after it. Otherwise they are served like any render frame.
export const thumbsOrigin = desktopScheme + '://thumbs';
export const renderOrigins: readonly string[] = [renderOrigin, thumbsOrigin];
export const isRenderOrigin = (origin: string) => renderOrigins.includes(origin);

export const channels = {
  updateState: 'app:update-state', updateChanged: 'app:update-changed', checkUpdates: 'app:check-updates', restartUpdate: 'app:restart-update', dismissUpdate: 'app:dismiss-update',
  prepareQuit: 'app:prepare-quit', prepareQuitAck: 'app:prepare-quit-ack', prepareQuitReply: 'app:prepare-quit-reply', cancelQuit: 'app:cancel-quit',
  contextMenu: 'app:context-menu', popupMenu: 'app:popup-menu', documentProxy: 'document:proxy', toolbarDragRegions: 'document:toolbar-drag-regions', presentation: 'document:presentation', dragSources: 'document:drag-sources', fileIcons: 'document:file-icons',
  showMarkdown: 'markdown:open', markdownAction: 'markdown:action', markdownChanged: 'markdown:changed', markdownPrepareClose: 'markdown:prepare-close',
  presentationState: 'presentation:state', presentationSpread: 'presentation:spread', presentationClose: 'presentation:close', presentationClosed: 'presentation:closed',
  showAssets: 'document:show-assets', showTemplates: 'library:show', templatePreview: 'library:preview',
  current: 'document:current', appError: 'app:error', appNotice: 'app:notice',
  recents: 'app:recents', recentsChanged: 'app:recents-changed', recentAction: 'app:recent-action',
  libraryRemote: 'books:remote', libraryBook: 'books:book', libraryAction: 'books:action', chooseBooksFolder: 'sync:choose-books-folder',
  sourceCommand: 'document:source-command', templateAction: 'library:action', sourceAction: 'document:source-action', saveCopy: 'document:save-copy',
  chooseStarter: 'app:choose-starter', documentAction: 'document:action',
  open: 'project:open', save: 'project:save', import: 'project:import', network: 'project:editor-network',
  command: 'project:command', changed: 'project:changed',
  export: 'project:export', progress: 'project:progress', cancel: 'project:cancel',
  check: 'project:check', cancelCheck: 'project:cancel-check',
  bookMenu: 'editor:book-menu',
  settings: 'app:settings', updateSettings: 'app:update-settings', settingsChanged: 'app:settings-changed',
  showSettings: 'app:show-settings', settingsPane: 'app:settings-pane', fitSettings: 'app:fit-settings',
  library: 'library:list', libraryChanged: 'library:changed', libraryImport: 'library:import', libraryRemove: 'library:remove',
  libraryExport: 'library:export', libraryTrust: 'library:trust',
  history: 'project:history', mcp: 'mcp:settings', mcpChanged: 'mcp:changed', mcpInstall: 'mcp:install',
  agentLease: 'project:agent-lease', agentLeaseReply: 'project:agent-lease-reply', agentRelease: 'project:agent-release',
  syncState: 'project:sync-state', syncChanged: 'project:sync-changed', syncAction: 'project:sync-action',
  chooseSyncFolder: 'app:choose-sync-folder',
  lightroom: 'lightroom:state', lightroomChanged: 'lightroom:changed', lightroomInstall: 'lightroom:install', lightroomLaunch: 'lightroom:launch',
  syncBackend: 'sync:backend', saveSyncBackend: 'sync:save-backend', testSyncConnection: 'sync:test-connection', syncUsage: 'sync:usage', syncCleanUpPlan: 'sync:clean-up-plan', syncCleanUp: 'sync:clean-up', syncSetupBooks: 'sync:setup-books', chooseSyncBooks: 'sync:choose-books',
} as const;

export type OpenAction = 'open' | 'new' | 'reload';
/**
 * A book's sync status (#251): `ahead` has changes to send, `behind` changes to take, `diverged` changes on both sides
 * (or several versions on the remote), `remote-syncing` a remote that has not caught up, `abandoned` a pull that was
 * given up (`detail` says why), `newer` records a newer ImageFlow wrote, `unavailable` a remote that cannot be read,
 * `removed` a book deleted from sync on another Mac (its tombstone), which pushes nothing until it is synced again.
 */
export type SyncStatus = {
  state: 'in-sync' | 'ahead' | 'behind' | 'diverged' | 'remote-syncing' | 'abandoned' | 'newer' | 'unavailable' | 'removed';
  detail?: string; tips?: number;
  /**
   * What the remote held when it was last read, against this Mac's last sync: its tip is that commit (`same`), a later
   * one (`moved`), or several (`forked`). With it, an edit updates the status from the local revision alone.
   */
  remote?: 'same' | 'moved' | 'forked';
  /** Owned originals that are only proxies on this Mac. */
  pendingOriginals: number;
  /** Of those, the ones another Mac has not uploaded yet: they are still uploading there, which is no sync error. */
  notUploaded?: number;
  /**
   * Originals a commit named a week or more ago that never arrived, in words: which Mac never uploaded them (#283).
   */
  neverUploaded?: string;
  /** With `unavailable`: the remote refused this Mac's credentials, which Settings → Sync fixes. */
  signIn?: true;
  /** With `unavailable`: the settings name no bucket there (missing, another region or endpoint); Settings → Sync fixes it. */
  checkSettings?: true;
};
/**
 * What the editor shows for sync: nothing for a book that does not sync, otherwise the name of the backend this Mac
 * syncs through (`folder`, ADR 0012) and the book's status. `downloading` counts the originals a download in the
 * background has fetched; Cancel stops it (`cancel-download`).
 */
export type SyncView = { folder: string; status?: SyncStatus; syncing?: boolean; message?: string; downloading?: { done: number; total: number };
  /**
   * Owned originals of this book still uploading from this Mac, in the background after the commit that named them:
   * how many went up of those pending. The book itself has synced.
   */
  uploading?: { done: number; total: number };
  /**
   * The remote is full (iCloud storage full), in the store's words: `notUploaded` owned originals wait for room while
   * the book itself synced (the background upload is paused until the next sync finds room), or none when the sync
   * itself failed because its commit or a preview did not fit. `manage` when the remote is iCloud, whose storage
   * System Settings manages (`manage-storage`).
   */
  storageFull?: { message: string; notUploaded?: number; manage?: true };
  /**
   * The last background upload of this book's originals failed (offline, a refused request): how many of this Mac's
   * originals are not uploaded (`left`; unknown when it failed before it could read the remote), and why. Shown until an
   * upload ends without; the next sync tries again.
   */
  uploadFailed?: { message: string; left?: number } };
/** `start` makes the book sync on this Mac (asking first when it last synced somewhere else), `stop` stops that. */
export type SyncAction = 'sync' | 'download' | 'cancel-download' | 'start' | 'stop' | 'manage-storage';
// The main canvas shows spreads in one vertical column, or a row-by-row grid with this many columns.
export type CanvasLayout = { mode: 'vertical' | 'grid'; columns: number };
export const gridColumns = [1, 2, 3, 4] as const;
export type LayoutCommand = 'layout-vertical' | 'layout-grid' | `grid-columns-${typeof gridColumns[number]}`;
export const spreadCommands = ['add-spread', 'duplicate-spread', 'move-spread-up', 'move-spread-down', 'delete-spread'] as const;
export type SpreadCommand = typeof spreadCommands[number];
export type ActiveBookEditor = { label: string; spread?: string; page?: PageSide; field?: string };
// What the editor answers an agent's request to save: yes, the editor the user has open, or what the app is busy with
// (an import, a reload after files changed, a drag), which ends by itself.
export type AgentLeaseReply = boolean | ActiveBookEditor | { busy: string };
export type BookMenuState = { document: boolean; enabled: Record<SpreadCommand, boolean>; editing: boolean; textEditing: boolean;
  writable: boolean; busy: boolean; history?: HistoryState; canExport: boolean;
  // The design proof leaves the cover out: it needs only a rendered book with spreads, in either view.
  canProof?: boolean; canSwapPages?: boolean; activeEditor?: ActiveBookEditor;
  sidebar?: boolean; inspector?: boolean; sources?: boolean; guides?: boolean; layout?: CanvasLayout; zoom?: number; photoView?: PhotoView;
  selectionCount?: number; selectedSpread?: string; saving?: boolean; importMode?: ImportMode; pageLabels?: Record<string, string>;
  view?: 'content' | 'cover'; coverBoxIds?: string[] };
export type Command = PhotoViewCommand | SpreadCommand | 'swap-pages' | 'book-check' | OpenAction | 'toggle-project' | 'toggle-inspector' | 'toggle-sources' | 'toggle-guides' | LayoutCommand | 'export' | 'export-proof' | 'import' | 'copy-assets' | 'presentation' | 'presentation-start' | 'manage-sources' | 'save-copy' | 'undo' | 'redo' | 'zoom-in' | 'zoom-out' | 'zoom-actual' | 'zoom-fit' | 'revert-opened';
export type ProjectSummary = ProjectFiles & {
  id: string; folder: string;
  handle?: string; history?: HistoryState; viewKey?: string;
  pageLabels?: Record<string, string>;
  coverBoxIds?: string[];
  photoDates?: Record<string, { captured: string; capturedEstimated?: boolean }>;
  // The template's hash as loaded; network approvals hold for one hash (ADR 0006).
  templateHash?: string;
  // The network origins this book's frames may reach now (ADR 0006).
  network?: string[];
  // Thumbnail URL and pixel size per readable photo; Markdown source per readable text.
  photos: Record<string, string>;
  photoRevisions?: Record<string, string>;
  photoSizes: Record<string, { width: number; height: number }>;
  // The title, caption, credit and alt text a photo's provider reports (ADR 0011), which photos.json overrides field
  // by field: the Inspector shows them as placeholders and offers to revert an override.
  photoProvided?: Record<string, ProvidedMetadata>;
  texts: Record<string, string>;
  sources?: Record<string, SourceStatus>;
};
// `existing`: files the book already holds, linked or copied, found by path or by content; they are not added again.
export type ImportCounts = { photos: number; texts: number; files: number; skipped: number; failed: number; existing?: number };
export type Result<T> = { value: T } | { error: string; code?: 'BOOK_BUSY' };
/**
 * Settings → Sync (#281; `available` is always true since #283). The renderer sends an access key to the main
 * process when it is entered and never gets it back: only whether one is stored, and the last characters of its ID.
 */
/**
 * `icloud` is there only in a build entitled to iCloud (#292), started with its flag (`IMAGEFLOW_SYNC_ICLOUD=1`): whether this Mac can use it now, and why not (signed
 * out, iCloud off for ImageFlow, restricted) when it cannot.
 */
/** `booksUnchosen`: the sheet that asks which recent books sync waits for an answer (`AppSettings.syncBooksUnchosen`). */
export type SyncBackendState = { available: boolean; credentials?: { stored: true; accessKeyEnd: string }; icloud?: { available: boolean; message?: string }; booksUnchosen?: true;
  /** Why the configured backend is not used by this build (iCloud without its flag), which leaves sync off. */
  unusable?: string;
  /** Whether the folder backend is offered (development and tests, `IMAGEFLOW_SYNC_FOLDER=1`). */
  folder?: true };
export type SyncCredentialsInput = { accessKeyId: string; secretAccessKey: string };
export type SyncBackendRequest = { backend: S3SyncBackend; credentials?: SyncCredentialsInput } | { backend: ICloudSyncBackend };
/** What Test Connection found: see `ConnectionReport` in desktop/sync-store-s3.ts. */
/**
 * A recent book in the first-configuration sheet: what its owned originals take up on this Mac (`bytes`, what syncing
 * it uploads at most), whether it is trusted here (only trusted books sync; choosing an untrusted one trusts it), and
 * whether it syncs with the backend already.
 */
/** What the books take up on the sync remote (Settings → Sync, #285): in all and per book, with the part that is originals. */
export type SyncStorage = { bytes: number; originals: number; books: { bookId: string; title: string; bytes: number; originals: number; deleted?: true }[] };
/** What Clean Up would free (#285): unused originals, previews and covers past the grace period, and what is left of deleted books. */
export type SyncCleanUpPlan = { bytes: number; objects: number; books: number; deletedBooks: number; skipped: number };
export type SyncSetupBook = { id: string; title: string; bytes: number; trusted: boolean; syncing: boolean };
export type SyncConnectionReport = { conditionalWrites: 'enforced' | 'ignored' | 'unsupported'; checksums: 'verified' | 'not-verified'; addressing: 'path' | 'virtual' };
export type HistoryState = { undo?: string; redo?: string };
// How an MCP client starts ImageFlow's stdio bridge. It does not change when the connection is enabled again.
export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };
export type McpSettings = { enabled: boolean; clients: { name: string }[]; launch: McpLaunch; claudeCode: string };
// `claude` opens Claude Desktop's extension installer; `codex` registers the bridge for the ChatGPT desktop app and
// Codex, which share ~/.codex/config.toml. `skill` saves the ImageFlow templates agent skill as an archive.
export type McpClientTarget = 'claude' | 'codex' | 'skill';
/**
 * What a long task of a window reports: what it is doing, how far it is when it counts something (`done` of `total`),
 * and whether the window's Cancel stops it. The status shows a bar for a count and Cancel beside it.
 */
export type TaskProgress = { text: string; done?: number; total?: number; cancel?: boolean };
// `stage` says what a reload the app started is doing, such as rendering previews of imported photos, with its count.
export type ProjectChange = Result<ProjectSummary> | { building: true; stage?: string; done?: number; total?: number };
/**
 * The ImageFlow plugin in Lightroom's Modules folder against the one this app bundles (ADR 0011): not there, the same,
 * older, newer, a link to a development copy, or a version that cannot be read.
 */
export type LightroomPluginStatus = { state: 'missing' | 'current' | 'outdated' | 'newer' | 'linked' | 'unknown'; installed?: string; available?: string };
/**
 * What Settings shows for Lightroom Classic: the plugin, whether the app is on this Mac and running (with its icon as a
 * data URL), and the catalog and plugin version of a connected Lightroom.
 */
export type LightroomState = { plugin: LightroomPluginStatus; app: { installed: boolean; running: boolean; icon?: string };
  connection?: { catalog?: string; plugin: string } };
// `file` imports into the files/ registry for file parameters, offering the parameter's `accept` extensions. Without a
// kind, `accept` lists the extensions of the template's file parameters: files of those types import as files.
export type ImportRequest = {
  kind?: 'photo' | 'markdown' | 'file'; mode?: ImportMode; paths?: string[]; folder?: boolean; accept?: string[]; target?: { spread: string; box: string; page?: PageSide };
};

/**
 * A book on this Mac as the Start window lists it (#283): `bookId` is its lineage, which books on the remote are matched
 * by; `syncs` says that it syncs on this Mac, so it stays listed beyond the 20 most recent.
 */
export type RecentDocument = { id: string; path: string; title: string; openedAt: string; available: boolean; cover?: string; bookId?: string; syncs?: true;
  /** This Mac's sync record of the book, read without the remote: which remote it syncs with, and whether it was stopped here. */
  sync?: { remoteId?: string; enabled?: boolean } };
/**
 * The books on the configured remote (#283), from one listing: each by its lineage, deleted from sync (`deleted`, its
 * tombstone) or marked by a newer ImageFlow (`newer`). `name` is what the app calls the backend ("iCloud", the bucket).
 */
export type LibraryRemote = { remoteId: string; name: string; books: { bookId: string; deleted?: true; newer?: true }[] };
/**
 * What the library shows of a book on the remote, loaded when its row comes into view and kept for the session: the
 * title and time of its latest version, how many versions (tips) it has, and its cover as a JPEG data URL the main
 * process made. `newer` for a book a newer ImageFlow synced.
 */
export type LibraryBook = { bookId: string; title: string; updatedAt?: string; versions: number; cover?: string; newer?: true };
/**
 * What the Start window asks of a book (#283): Download a book only on the remote, Delete from Sync (asked in the main
 * process first), Update for one a newer ImageFlow synced, and for a book on this Mac (`id`, its recent entry) Start
 * Syncing, Stop Syncing on This Mac, and for one deleted from sync elsewhere Keep Here Only or Sync Again.
 */
export type LibraryAction = { action: 'download' | 'delete' | 'update'; bookId: string } | { action: 'start' | 'stop' | 'keep-here' | 'sync-again' | 'delete'; id: string };

export type SourceAction = { action: 'retry' | 'launch' | 'locate' | 'replace' | 'reveal' | 'copy' | 'collect' | 'locate-folder' | 'remove' | 'preview' | 'open' | 'place' | 'jump' | 'import' | 'rename'; spread?: string; key?: string; keys?: string[]; accept?: string[]; paths?: string[]; name?: string };

export type ContextMenuItem = import('./commands').RegisteredCommand | { command: import('./commands').RegisteredCommand; value?: string; label?: string; enabled?: boolean; checked?: boolean; items?: ContextMenuItem[] } | { type: 'separator' };
export type ContextMenuResult = { command: import('./commands').RegisteredCommand; value?: string };
export type SourceCommand = { action: 'place'; keys: string[] } | { action: 'jump'; spread: string };
export type PopupItem = { id?: string; label?: string; type?: 'separator'; enabled?: boolean; checked?: boolean; toolTip?: string; submenu?: PopupItem[] };
export type MarkdownState = {
  id: string; name: string; path: string; external: boolean; text: string; version: number; basis: number;
  dirty: boolean; saving: boolean; closing?: boolean; error?: string; conflict?: string;
};
export type MarkdownAction = { action: 'state' | 'save' } | { action: 'change' | 'closing'; text: string; version: number; basis: number }
  | { action: 'reload' | 'keep'; conflict: string };
export type DesktopApi = {
  updateState(): Promise<import('./updates').UpdateState>;
  onUpdateChanged(listener: (state: import('./updates').UpdateState) => void): () => void;
  checkUpdates(): Promise<void>;
  restartUpdate(): Promise<void>;
  dismissUpdate(): Promise<void>;
  onPrepareQuit(listener: () => boolean | Promise<boolean>): () => void;
  onCancelQuit(listener: () => void): () => void;
  showMarkdown(request: { id: string } | { name: string }): Promise<Result<void>>;
  markdownAction(request: MarkdownAction): Promise<Result<MarkdownState>>;
  onMarkdownPrepareClose(listener: () => void): () => void;
  onMarkdownChanged(listener: (state: MarkdownState) => void): () => void;
  showContextMenu(items: ContextMenuItem[], state?: BookMenuState): Promise<ContextMenuResult | null>;
  onSourceCommand(listener: (command: SourceCommand) => void): () => void;
  templateAction(id: string, action: 'reveal' | 'new'): Promise<Result<void>>;
  popupMenu(items: PopupItem[], point?: { x: number; y: number }): Promise<string | null>;
  startPresentation(spread: string): Promise<Result<void>>;
  presentationState(): Promise<Result<{ summary: ProjectSummary; start: string }>>;
  setPresentationSpread(spread: string): Promise<void>;
  closePresentation(spread?: string): Promise<void>;
  onPresentationClosed(listener: (spread: string) => void): () => void;
  documentProxy(action: 'path' | 'drag'): Promise<void>;
  setToolbarDragRegions(regions: Rect[]): Promise<void>;
  dragSources(keys: string[]): Promise<void>;
  // The system document icon of each file extension, as image data URLs keyed by extension.
  fileIcons(extensions: string[]): Promise<Record<string, string>>;
  showAssets(accept: string[]): Promise<Result<void>>;
  showTemplates(): Promise<void>;
  templatePreview(id: string, hash: string): Promise<Result<string | null>>;
  sourceAction(request: SourceAction): Promise<Result<{ summary: ProjectSummary; message?: string }>>;
  saveCopy(includeAssets?: boolean): Promise<Result<null>>;
  currentProject(): Promise<Result<ProjectSummary>>;
  onAppError(listener: (message: string) => void): () => void;
  onAppNotice(listener: (message: string) => void): () => void;
  /** The book's sync status (#251), null when it does not sync on this Mac. */
  syncState(): Promise<Result<SyncView | null>>;
  onSyncChanged(listener: (view: SyncView | null) => void): () => void;
  syncAction(action: SyncAction): Promise<Result<void>>;
  recentDocuments(): Promise<Result<RecentDocument[]>>;
  onRecentsChanged(listener: () => void): () => void;
  recentDocument(id: string, action: 'open' | 'locate' | 'remove' | 'reveal'): Promise<Result<null>>;
  /** The books on the configured remote, for the Start window: kept for the session; `refresh` reads the remote again. */
  libraryRemote(refresh?: boolean): Promise<Result<LibraryRemote | null>>;
  /** A book on the remote as its library row shows it, loaded as the row comes into view. */
  libraryBook(bookId: string): Promise<Result<LibraryBook>>;
  libraryAction(request: LibraryAction): Promise<Result<null>>;
  /** Settings → Sync: asks, in the app's own dialog, for the folder Download puts books in; null when cancelled. */
  chooseBooksFolder(): Promise<Result<AppSettings | null>>;
  // The New Book picker's choice; nothing cancels.
  chooseStarter(choice?: NewBookChoice): Promise<Result<boolean>>;
  // The template library, and changes to it from any window.
  library(): Promise<Result<LibraryEntry[]>>;
  onLibraryChanged(listener: () => void): () => void;
  // Asks for template folders or .imageflow-template files to import; from Settings or the New Book picker.
  importTemplates(paths?: string[]): Promise<Result<LibraryImportResult[]>>;
  // Asks to move an imported template to the Trash; false when the user cancels.
  removeTemplate(id: string): Promise<Result<boolean>>;
  // Asks where to save a library entry as an .imageflow-template file; the file, or null when the user cancels.
  exportTemplate(id: string): Promise<Result<string | null>>;
  // Allows or stops allowing the network sites a library entry's exact version declares, in every book made from it.
  trustTemplate(id: string, allow: boolean): Promise<Result<boolean>>;
  documentAction(action: 'reveal' | 'template' | 'text', id?: string): Promise<Result<void>>;
  getSettings(): Promise<Result<AppSettings>>;
  // Asks for the folder this Mac syncs through and sets it as the sync backend; null when the user cancels. For development
  // and tests only (`IMAGEFLOW_SYNC_FOLDER=1`).
  chooseSyncFolder(): Promise<Result<AppSettings | null>>;
  updateSettings(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  showSettings(pane: SettingsPane): Promise<void>;
  // The pane Settings should show: read once when it loads, then pushed while it stays open.
  settingsPane(): Promise<SettingsPane>;
  onSettingsPane(listener: (pane: SettingsPane) => void): () => void;
  // Settings sizes its native window to the current pane's content height.
  fitSettings(height: number): Promise<void>;
  // Settings → Sync: the backend's credentials and its connection test (main process only holds the secret).
  syncBackendState(): Promise<Result<SyncBackendState>>;
  /** Saves the backend with credentials when given (otherwise those stored for it); null removes both. */
  saveSyncBackend(request: SyncBackendRequest | null): Promise<Result<SyncBackendState>>;
  testSyncConnection(request: SyncBackendRequest): Promise<Result<SyncConnectionReport>>;
  /** What the books stored through the configured backend take up there, in bytes (Settings → Sync shows it for iCloud). */
  syncUsage(): Promise<Result<SyncStorage>>;
  /** Finds what Clean Up would delete, and deletes nothing. */
  syncCleanUpPlan(): Promise<Result<SyncCleanUpPlan>>;
  /** Asks in the main process, then deletes what the last plan found after reading every book's commits again. */
  syncCleanUp(): Promise<Result<{ bytes: number; objects: number } | { cancelled: true }>>;
  /** The recent books for the sheet shown when a backend is first set up, which asks which of them to sync. */
  syncSetupBooks(): Promise<Result<SyncSetupBook[]>>;
  /** The sheet's answer: the books to sync (`sync: true`) and those opted out for this backend. Uploads nothing by itself. */
  chooseSyncBooks(choices: { id: string; sync: boolean }[]): Promise<Result<void>>;
  // The window's panel and canvas layout state, so the View menu can show it.
  setBookMenuState(state: BookMenuState): Promise<void>;
  openProject(action: OpenAction): Promise<Result<ProjectSummary | null>>;
  saveProject(id: string, files: ProjectFiles, label?: string): Promise<Result<ProjectSummary>>;
  history(id: string, direction: 'undo' | 'redo'): Promise<Result<ProjectSummary>>;
  mcpSettings(enabled?: boolean): Promise<Result<McpSettings>>;
  onMcpChanged(listener: (settings: McpSettings) => void): () => void;
  installMcp(target: McpClientTarget): Promise<Result<string>>;
  // The Lightroom Classic plugin (ADR 0011): its state, changes to it, and installing or updating it from Settings.
  lightroomState(): Promise<Result<LightroomState>>;
  onLightroomChanged(listener: (state: LightroomState) => void): () => void;
  installLightroomPlugin(): Promise<Result<{ state: LightroomState; message: string }>>;
  launchLightroom(): Promise<Result<void>>;
  // `footprint`: the layouts the agent's save changes, or the whole book (agent-footprint.ts).
  onAgentLease(listener: (id: string, footprint?: import('./agent-footprint').AgentFootprint) => AgentLeaseReply): () => void;
  onAgentRelease(listener: () => void): () => void;
  importFiles(id: string, request: ImportRequest): Promise<Result<{ summary: ProjectSummary; imported: string[]; counts?: ImportCounts } | null>>;
  // Asks once per book to let its frames reach the template's declared origins; resolves to those allowed, with a new
  // summary to render when that changed what the frames may reach.
  editorNetwork(id: string, origins: string[]): Promise<Result<{ origins: string[]; summary?: ProjectSummary }>>;
  pathsForFiles(files: File[]): string[];
  exportBook(id: string, surface?: 'cover' | 'proof'): Promise<Result<{ warnings: Issue[]; errors: Issue[] } | null>>;
  cancelExport(): Promise<void>;
  checkBook(id: string, request: AuthoringCheckRequest): Promise<Result<AuthoringCheckResult>>;
  cancelCheck(): Promise<void>;
  onCommand(listener: (command: Command) => void): () => void;
  onProjectChanged(listener: (result: ProjectChange) => void): () => void;
  onProgress(listener: (progress: string | TaskProgress) => void): () => void;
};

// `editor` describes a template-supplied editor for some of the element's parameters, and for the layout (spread)
// parameters it lists in `spread` (the component itself stays in the render frame).
// `controls` arranges the generated controls of a scope's parameters (src/controls.ts).
export type ElementDefinition = {
  label: string; parameters: Parameters; controls?: ControlItem[]; editor?: { label?: string; parameters: string[]; spread?: string[]; presentation: 'dialog' | 'inline' };
};
export type BoxDefinition = { type: 'photo' | 'markdown'; label: string; parameters: Parameters; flowOrder?: number; composition?: string; controls?: ControlItem[] };
// `family` names the layout family this layout is a variant of; `variant` holds the template's tags for it.
export type SpreadDefinition = {
  sides?: PageSide[];
  label: string; span: Span; parameters: Parameters; controls?: ControlItem[];
  boxes: Record<string, BoxDefinition>; elements: Record<string, ElementDefinition>;
  declaresAnchors?: boolean;
  declaresCredits?: boolean;
  family?: string; variant?: Record<string, string | number | boolean>;
};
export type CoverLayoutInfo = Pick<SpreadDefinition, 'label' | 'parameters' | 'controls' | 'boxes' | 'elements'> & { formats?: string[] };
export type TemplateInfo = {
  // The template's identity and its library metadata; `id` is absent in summaries from apps that predate it.
  id?: string; label?: string; description?: string;
  // The template it was forked from (`basedOn` in defineTemplate).
  basedOn?: { id: string; version: string };
  // The template's own preview image, relative to the template folder (`preview` in defineTemplate).
  preview?: string;
  version: string; parameters: Parameters; spreads: Record<string, SpreadDefinition>;
  // Arranges the document parameters' controls in Book settings; all of them in declaration order when absent.
  controls?: ControlItem[];
  // Families of layouts, by ID. `picker` is set when the family supplies its own picker (the component stays in the
  // render frame).
  layoutFamilies?: Record<string, { label: string; picker?: { label?: string; choice?: { tag: string; options: Record<string, string> } } }>;
  // The spreads a new book from this template starts with; empty when it starts without spreads.
  openingSpreads?: import('./editing').OpeningSpreadInput[];
  // Editors of document parameters, by ID, with the parameters each owns (the components stay in the render frame).
  editors?: Record<string, { label?: string; parameters: string[]; presentation?: 'dialog' | 'inline' }>;
  // HTTPS origins the template's element editors may reach once the user allows them (ADR 0006).
  network?: string[];
  // The format in use, its ID, and the labels of all formats the template offers.
  format: PrintFormat; formatId: string; formats: Record<string, string>;
  // Each format's structure (facing pages, delivery, ends, page count), by format ID ('default' for a template with
  // one format), so commands and fixtures can check layouts against a format other than the current one. Absent in
  // summaries from apps that predate it.
  structures?: Record<string, PrintFormat['structure']>;
  // Every format the template offers, in full (trim, bleed, safe area, structure, page count and output), by format ID
  // ('default' for a template with one format), so an agent can compare presets without reading the template source.
  // Absent in summaries from apps that predate it.
  printFormats?: Record<string, PrintFormat>;
  coverFormats?: Record<string, CoverFormat>;
  coverLayouts?: Record<string, CoverLayoutInfo>;
};
export type BoxLocation = { id: string; type: 'photo' | 'markdown'; x: number; y: number; width: number; height: number };
// The editor shows the whole book in two frames: the scrolling spread view and the sidebar thumbnails.
// The layout picker renders one spread in every layout of the template.
export type BookView = 'book' | 'thumbs' | 'layouts' | 'present';
export const bookLayout: Record<BookView, { pad: number; gap: number; columns?: number; columnGap?: number }> = {
  present: { pad: 0, gap: 0 },
  book: { pad: 32, gap: 40 },
  thumbs: { pad: 12, gap: 34 },
  layouts: { pad: 6, gap: 26, columns: 4, columnGap: 10 },
};
export type Rect = { x: number; y: number; width: number; height: number };
// Posted by a book frame after layout. Coordinates are relative to the frame document. `columns` is set when the
// book view is laid out as a grid; the frame fits the canvas width and reports the height of all rows.
export type BookGeometry = {
  type: 'geometry'; width: number; height: number; columns?: number;
  // `zoom` is the preview's scale of the sheet: its rectangle here divided by its printed size in CSS pixels.
  sheets: (Rect & { spread: string; zoom?: number })[];
  // `upright` is false when template CSS rotates or skews the box, so its rectangle is only a bounding box.
  // `custom` marks a photo box the template draws with a render callback; the crop editor then lets its artwork show.
  // `page` is the page a box or element is on when the spread is shown as page layouts (ADR 0009); IDs repeat across pages.
  boxes: (Rect & { spread: string; id: string; page?: PageSide; type: BoxLocation['type'] | 'element'; upright: boolean; rect?: Rect; custom?: boolean })[];
  // Nodes a template marked with `ctx.edit(...)`, and boxes and elements with parameters. `owner` is the box or
  // element the node is, so targets that share a rectangle stay apart; standalone marked nodes have none.
  // `occurrence` counts the earlier nodes on the sheet that edit the same fields, so repeated uses of a field, such
  // as a heading shown twice, are separate targets that edit the same saved value.
  // `page` is the page the node is on, for every target: occurrences are counted per page.
  targets: (Rect & { spread: string; page?: PageSide; edits: string[]; occurrence: number; owner?: { type: 'box' | 'element'; id: string }; upright?: boolean;
    inlineText?: boolean;
    // True for text in a vertical writing mode, whose lines run down the rectangle.
    vertical?: boolean;
    textFallback?: { parameter: string; text: string; label: string } })[];
};
// A preflight finding. `spread` is the spread id and `where` its readable location, such as "Pages 6–7 · Photo grid".
// The optional fields give agents a stable `code`, the box/element/source involved, measured values and a repair hint.
export type Issue = {
  message: string; spread?: string; where?: string;
  cover?: true;
  code?: string; box?: string; element?: string; source?: string; parameter?: string;
  // The page of a spread shown as page layouts that the box or element is on.
  page?: PageSide;
  details?: Record<string, string | number>; suggestion?: string;
};
export const issueText = ({ message, where, page }: Issue) => [where, page ? page + ' page' : undefined, message].filter(Boolean).join(' · ');
export type RenderStatus = {
  state: 'ready'; template: TemplateInfo; pages: number;
  units: { side: PrintSide; spread: string; where: string }[];
  errors: Issue[]; warnings: Issue[];
  flow: Record<string, { part: number; parts: number; title?: string }>;
  // Anchors the layouts declare, with the page each resolves to, in page order.
  anchors: { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' | 'page' }[];
  inspection?: import('./inspection').ElementInspection;
  cover?: Exclude<CoverResolution, { status: 'unavailable' }>;
} | {
  state: 'error'; message: string; template?: TemplateInfo;
  // Spreads whose layout threw or rendered no single <Spread> root, with the stack where template code threw.
  layoutFailures?: LayoutFailure[];
  // Declarations that violate the template contract, by path such as `spreads.chapter.parameters.heading.default`.
  declarationIssues?: { path: string; message: string }[];
  // Stack of any other failure, such as template module code that throws when imported.
  stack?: string;
};
export type LayoutFailure = { spread: string; page?: PageSide; message: string; stack?: string };

declare global {
  interface Window {
    imageflow?: DesktopApi;
    imageflowRenderStatus?: RenderStatus;
  }
}

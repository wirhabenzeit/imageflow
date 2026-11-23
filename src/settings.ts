import type { UpdateChannel } from './update-feed';
export type Appearance = 'light' | 'dark' | 'system';
export type SettingsPane = 'general' | 'sources' | 'agents' | 'sync';
/**
 * Where this Mac syncs books (ADR 0012, section 2): one backend at a time, by `kind`. An S3-compatible bucket names its
 * server, region, bucket and an optional key prefix; its access key and secret are kept apart from these settings, in
 * the main process's credential store (desktop/sync-credentials.ts). `addressing` overrides how the bucket is named in
 * URLs: virtual-hosted for AWS endpoints, path style for every other service unless set.
 */
export type FolderSyncBackend = { kind: 'folder'; path: string };
export type S3SyncBackend = { kind: 's3'; endpoint: string; region: string; bucket: string; prefix?: string; addressing?: 'path' | 'virtual' };
/** The user's private iCloud database (#292): nothing to set up on a Mac signed in to iCloud, in a build entitled to it. */
export type ICloudSyncBackend = { kind: 'icloud' };
export type SyncBackend = FolderSyncBackend | S3SyncBackend | ICloudSyncBackend;

// App preferences belong to this computer, independently of any open book. `agentAccess` remembers that the user
// allowed agents to use open books, so the connection starts again with the app; only the Agents pane changes it.
// `keepOriginals`: synced books download their owned originals to this Mac in the background after opening and after
// each sync (#251). On unless set to false, which keeps only previews here until Download Originals.
// `sync`: the backend books sync through on this Mac (ADR 0012), one at a time. Each kind is one member of the union.
export type AppSettings = { appearance: Appearance; automaticUpdates: boolean; updateChannel: UpdateChannel; newBookSize?: { width: number; height: number }; agentAccess?: boolean;
  keepOriginals?: boolean; sync?: SyncBackend };
export const defaultSettings: AppSettings = { appearance: 'system', automaticUpdates: true, updateChannel: 'stable' };

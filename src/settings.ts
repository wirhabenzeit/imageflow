import type { UpdateChannel } from './update-feed';
export type Appearance = 'light' | 'dark' | 'system';
export type SettingsPane = 'general' | 'sources' | 'agents';

// App preferences belong to this computer, independently of any open book. `agentAccess` remembers that the user
// allowed agents to use open books, so the connection starts again with the app; only the Agents pane changes it.
// `keepOriginals`: synced books download their owned originals to this Mac in the background after opening and after
// each sync (#251). On unless set to false, which keeps only previews here until Download Originals.
export type AppSettings = { appearance: Appearance; automaticUpdates: boolean; updateChannel: UpdateChannel; newBookSize?: { width: number; height: number }; agentAccess?: boolean;
  keepOriginals?: boolean };
export const defaultSettings: AppSettings = { appearance: 'system', automaticUpdates: true, updateChannel: 'stable' };

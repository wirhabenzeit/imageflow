import type { UpdateChannel } from './update-feed';
export type Appearance = 'light' | 'dark' | 'system';
export type SettingsPane = 'general' | 'agents';

// App preferences belong to this computer, independently of any open book. `agentAccess` remembers that the user
// allowed agents to use open books, so the connection starts again with the app; only the Agents pane changes it.
// `fasterBookUpdates` (on unless turned off) lets the book view and its thumbnails render each edit in place instead of in
// new frames (#210); off, every edit renders the book anew, as before.
export type AppSettings = { appearance: Appearance; automaticUpdates: boolean; updateChannel: UpdateChannel; newBookSize?: { width: number; height: number }; agentAccess?: boolean;
  fasterBookUpdates?: boolean };
export const defaultSettings: AppSettings = { appearance: 'system', automaticUpdates: true, updateChannel: 'stable' };

import type { UpdateChannel } from './update-feed';
export type Appearance = 'light' | 'dark' | 'system';
export type SettingsPane = 'general' | 'agents';

// App preferences belong to this computer, independently of any open book.
export type AppSettings = { appearance: Appearance; automaticUpdates: boolean; updateChannel: UpdateChannel; newBookSize?: { width: number; height: number } };
export const defaultSettings: AppSettings = { appearance: 'system', automaticUpdates: true, updateChannel: 'stable' };

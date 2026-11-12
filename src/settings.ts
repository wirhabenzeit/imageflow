export type Appearance = 'light' | 'dark' | 'system';
export type SettingsPane = 'general' | 'agents';

// App preferences belong to this computer, independently of any open book.
export type AppSettings = { appearance: Appearance };
export const defaultSettings: AppSettings = { appearance: 'system' };

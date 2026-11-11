export type Appearance = 'light' | 'dark' | 'system';

// App preferences belong to this computer, independently of any open book.
export type AppSettings = { appearance: Appearance };
export const defaultSettings: AppSettings = { appearance: 'system' };

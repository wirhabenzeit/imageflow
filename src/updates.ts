export type UpdateState = {
  status: 'initializing' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'unavailable';
  message?: string;
  release?: string;
  installedVersion?: string;
  dismissed?: boolean;
  notice?: boolean;
};

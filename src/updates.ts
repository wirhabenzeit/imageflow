export type UpdateState = {
  status: 'initializing' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'unavailable';
  message?: string;
  release?: string;
  dismissed?: boolean;
  notice?: boolean;
};

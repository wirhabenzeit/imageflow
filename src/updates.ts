export type UpdateState = {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'unavailable';
  message?: string;
  release?: string;
};

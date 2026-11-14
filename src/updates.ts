export type UpdateState = {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'unavailable';
  message?: string;
  release?: string;
  // Set when "Later" was chosen for a ready update, so no window shows the notice again.
  dismissed?: boolean;
};

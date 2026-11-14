import type { UpdateState } from '../src/updates';

export interface UpdateDriver {
  // Initialization configures the public feed and starts its first check.
  initialize(): void;
  check(): void;
  install(): void;
}

/** Own scheduling so disabling automatic checks never disables the manual command. */
export class AppUpdater {
  state: UpdateState = { status: 'idle' };
  private initialized = false;
  private eligible = true;
  private manualRequested = false;
  private timer?: ReturnType<typeof setInterval>;
  private restarting = false;
  private automatic = false;
  constructor(private options: {
    driver: UpdateDriver;
    unavailable?: string;
    pending?: boolean;
    changed: (state: UpdateState) => void;
    quit: () => void;
    interval?: number;
  }) {
    this.eligible = !options.pending;
    if (options.pending) this.state = { status: 'initializing' };
    else if (options.unavailable) this.state = { status: 'unavailable', message: options.unavailable };
  }
  private publish(state: UpdateState) { this.state = state; this.options.changed(state); }
  setEligibility(unavailable?: string) {
    this.options.unavailable = unavailable;
    this.eligible = true;
    this.publish(unavailable ? { status: 'unavailable', message: unavailable } : { status: 'idle' });
    this.schedule();
    if (this.manualRequested) { this.manualRequested = false; this.check(); }
  }
  setAutomatic(enabled: boolean) {
    if (enabled === this.automatic) return;
    this.automatic = enabled;
    this.schedule();
  }
  private schedule() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.automatic || !this.eligible || this.options.unavailable) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.options.interval ?? 4 * 60 * 60 * 1000);
    this.timer.unref();
  }
  check() {
    if (!this.eligible) { this.manualRequested = true; return; }
    if (this.options.unavailable || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    this.publish({ status: 'checking' });
    try {
      if (!this.initialized) { this.options.driver.initialize(); this.initialized = true; }
      else this.options.driver.check();
    } catch (error) { this.failed(error); }
  }
  available() { if (this.state.status !== 'ready') this.publish({ status: 'downloading' }); }
  current() { if (this.state.status !== 'ready') this.publish({ status: 'current' }); }
  downloaded(release?: string) { this.publish({ status: 'ready', release }); }
  dismissNotice() { if (this.state.status === 'ready') this.publish({ ...this.state, dismissed: true }); }
  failed(error: unknown) {
    console.warn('ImageFlow update check failed', error);
    if (this.state.status !== 'ready') this.publish({ status: 'error', message: 'Could not check for updates. Check your internet connection and try again.' });
  }
  restart() {
    if (this.state.status !== 'ready' || this.restarting) return;
    this.restarting = true;
    this.options.quit(); // The ordinary save/close/lock cleanup path must finish first.
  }
  cancelRestart() { this.restarting = false; }
  finishQuit() {
    this.dispose();
    if (!this.restarting || this.state.status !== 'ready') return false;
    this.restarting = false;
    this.options.driver.install();
    return true;
  }
  dispose() { this.automatic = false; this.manualRequested = false; clearInterval(this.timer); this.timer = undefined; }
}

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
  private timer?: ReturnType<typeof setInterval>;
  private restarting = false;
  private automatic = false;
  // Eligibility (signature, install location) is checked in the background so it never delays launch.
  private pending = false;
  private checkRequested = false;
  private blocked?: string;
  constructor(private options: {
    driver: UpdateDriver;
    unavailable?: string;
    eligibility?: Promise<string | undefined>;
    changed: (state: UpdateState) => void;
    quit: () => void;
    interval?: number;
  }) {
    if (options.unavailable) this.block(options.unavailable, false);
    else if (options.eligibility) {
      this.pending = true;
      options.eligibility.then((message) => this.settle(message),
        () => this.settle('Updates are available in the Developer ID signed release of ImageFlow.'));
    }
  }
  private publish(state: UpdateState) { this.state = state; this.options.changed(state); }
  private block(message: string, publish = true) {
    this.blocked = message;
    this.dispose();
    const state: UpdateState = { status: 'unavailable', message };
    if (publish) this.publish(state); else this.state = state;
  }
  private settle(message: string | undefined) {
    if (!this.pending) return;
    this.pending = false;
    if (message) { this.block(message); return; }
    const requested = this.checkRequested;
    this.checkRequested = false;
    // A manual check made while eligibility was pending showed "Checking…"; run it now.
    if (this.state.status === 'checking') this.state = { status: 'idle' };
    if (this.automatic) this.schedule();
    else if (requested) this.check();
  }
  private schedule() {
    clearInterval(this.timer);
    this.check();
    this.timer = setInterval(() => this.check(), this.options.interval ?? 4 * 60 * 60 * 1000);
    this.timer.unref();
  }
  setAutomatic(enabled: boolean) {
    if (enabled === this.automatic) return;
    this.automatic = enabled;
    clearInterval(this.timer);
    this.timer = undefined;
    if (!enabled || this.blocked || this.pending) return;
    this.schedule();
  }
  check() {
    if (this.blocked || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    if (this.pending) { this.checkRequested = true; this.publish({ status: 'checking' }); return; }
    this.publish({ status: 'checking' });
    try {
      if (!this.initialized) { this.options.driver.initialize(); this.initialized = true; }
      else this.options.driver.check();
    } catch (error) { this.failed(error); }
  }
  available() { if (this.state.status !== 'ready') this.publish({ status: 'downloading' }); }
  current() { if (this.state.status !== 'ready') this.publish({ status: 'current' }); }
  downloaded(release?: string) { this.publish({ status: 'ready', release }); }
  /** "Later" hides the notice in every window; menu and Settings keep offering the restart. */
  dismiss() { if (this.state.status === 'ready' && !this.state.dismissed) this.publish({ ...this.state, dismissed: true }); }
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
  dispose() { clearInterval(this.timer); this.timer = undefined; }
}

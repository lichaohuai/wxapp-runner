/** Window visibility is independent of keyboard focus (DevTools may own focus). */
export class ApplicationVisibility {
  private ready = false;
  private hidden = false;
  private minimized = false;
  private background = false;
  constructor(private changed: (background: boolean) => void) {}
  start() {
    this.ready = true;
    this.flush();
  }
  update(state: { hidden?: boolean; minimized?: boolean }) {
    if (state.hidden !== undefined) this.hidden = state.hidden;
    if (state.minimized !== undefined) this.minimized = state.minimized;
    this.flush();
  }
  private flush() {
    if (!this.ready) return;
    const next = this.hidden || this.minimized;
    if (next === this.background) return;
    this.background = next;
    this.changed(next);
  }
  snapshot() {
    return {
      ready: this.ready,
      hidden: this.hidden,
      minimized: this.minimized,
      background: this.background,
    };
  }
}

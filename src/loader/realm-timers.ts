/** Timers belong to a realm, not the process hosting all mini-program realms. */
export class RealmTimers {
  private handles = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  readonly globals = {
    setTimeout: (callback: Function, delay?: number, ...args: any[]) =>
      this.schedule(false, callback, delay, args),
    setInterval: (callback: Function, delay?: number, ...args: any[]) =>
      this.schedule(true, callback, delay, args),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => this.clear(handle),
    clearInterval: (handle: ReturnType<typeof setTimeout>) =>
      this.clear(handle),
  };
  private schedule(
    repeat: boolean,
    callback: Function,
    delay: number | undefined,
    args: any[],
  ) {
    if (this.closed) throw Error("CONTEXT_CLOSED: timer owner destroyed");
    if (typeof callback !== "function")
      throw TypeError("Timer callback must be a function");
    const handle = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) this.handles.delete(handle);
      if (!this.closed) callback(...args);
    }, delay);
    this.handles.add(handle);
    return handle;
  }
  private clear(handle: ReturnType<typeof setTimeout>) {
    // A context cannot clear another context's host timer.
    if (!this.handles.delete(handle)) return;
    clearTimeout(handle);
  }
  close() {
    this.closed = true;
    for (const h of this.handles) clearTimeout(h);
    this.handles.clear();
  }
}

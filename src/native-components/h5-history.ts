type History = {
  getActiveIndex(): number;
  getEntryAtIndex(index: number): { url: string } | null;
  length(): number;
  removeEntryAtIndex(index: number): boolean;
};

/** The host deliberately loads one blank document to attach its observer before
 * business navigation. Only that initial entry is ours; never clear SPA or
 * redirect history created by the actual website. */
export class H5History {
  private bootstrapPending = true;
  discardBootstrap(history: History) {
    if (!this.bootstrapPending) return;
    const first = history.getEntryAtIndex(0);
    if (!first) return;
    if (first.url !== "about:blank") {
      // Chromium may replace its initial entry instead of appending one.
      this.bootstrapPending = false;
    } else if (history.getActiveIndex() > 0 && history.removeEntryAtIndex(0)) {
      this.bootstrapPending = false;
    }
  }
  snapshot(history: History) {
    const activeIndex = history.getActiveIndex();
    const floor =
      this.bootstrapPending && history.getEntryAtIndex(0)?.url === "about:blank"
        ? 1
        : 0;
    return {
      length: history.length(),
      activeIndex,
      backSteps: Math.max(0, activeIndex - floor),
      bootstrapPending: this.bootstrapPending,
    };
  }
  backSteps(history: History, delta: number) {
    if (!Number.isSafeInteger(delta) || delta < 1)
      throw Error("Invalid HTMLWebView back delta");
    this.discardBootstrap(history);
    return Math.min(delta, this.snapshot(history).backSteps);
  }
}

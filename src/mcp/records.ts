/** Monotonic cursors survive eviction; readers can distinguish loss from an empty page. */
export class RecordLog<T extends object> {
  private rows: (T & { id: number })[] = [];
  private seq = 0;
  constructor(private capacity = 500) {}
  push(value: T) {
    const row = { ...value, id: ++this.seq };
    this.rows.push(row);
    if (this.rows.length > this.capacity) this.rows.shift();
    return row;
  }
  page(after = 0, limit = 50) {
    const oldestId = this.rows[0]?.id ?? this.seq + 1;
    const available = this.rows.filter((row) => row.id > after);
    const entries = available.slice(0, limit);
    return {
      entries,
      nextCursor: entries.at(-1)?.id ?? after,
      latestId: this.seq,
      hasMore: available.length > entries.length,
      oldestId,
      droppedBefore: oldestId - 1,
      gap: after < oldestId - 1,
      cursorResetRequired: after > this.seq,
    };
  }
}

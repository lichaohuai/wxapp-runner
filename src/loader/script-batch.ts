/** Official PageFrame's eval(codes) runs every code in the same JS turn.
 * Fetching is asynchronous, evaluation is not. The shared cache also covers
 * ordinary script tags so overlapping native loads never execute twice.
 */
export class ScriptBatch {
  constructor(
    private loaded: Map<string, Promise<void>>,
    private read: (file: string) => Promise<string>,
    private evaluate: (file: string, source: string) => void,
  ) {}

  load(files: string[]): Promise<void> {
    const waits: Promise<void>[] = [],
      fresh: { file: string; resolve(): void; reject(error: unknown): void }[] =
        [];
    for (const file of new Set(files)) {
      const existing = this.loaded.get(file);
      if (existing) {
        waits.push(existing);
        continue;
      }
      let resolve!: () => void, reject!: (error: unknown) => void;
      const pending = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void pending.catch(() => {});
      this.loaded.set(file, pending);
      fresh.push({ file, resolve, reject });
    }
    return (async () => {
      try {
        const [codes] = await Promise.all([
          Promise.all(fresh.map((entry) => this.read(entry.file))),
          Promise.all(waits),
        ]);
        for (let i = 0; i < fresh.length; i++) {
          this.evaluate(fresh[i].file, codes[i]);
          fresh[i].resolve();
        }
      } catch (error) {
        // Evaluated prefixes stay evaluated. Failed/unexecuted scripts remain
        // failed; another lazy-load request cannot replay partial side effects.
        for (const entry of fresh) entry.reject(error);
        throw error;
      }
    })();
  }
}

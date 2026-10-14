import { officialModule } from "./official-module";

/** The official manager owns identity/reuse; this port replaces browser frames.
 * An allocated ID is usable before its asynchronous loaded acknowledgement. */
export class OfficialContexts {
  readonly provenance: any[] = [];
  readonly manager: any;
  readonly api: any;
  private pending = new Set<Promise<unknown>>();
  private errors: unknown[] = [];
  private live = new Map<number, any>();
  private sequence = 0;
  private closed = false;
  private cancelConfiguration: () => void = () => {};
  constructor(
    baselibDir: string,
    config: any,
    private host: {
      create(id: number, options: any): any;
      ready?(id: number, signal?: AbortSignal): void | Promise<void>;
      evaluate(
        id: number,
        source: { code: string; src?: string; type?: string },
      ): unknown;
      dispose(id: number): void;
      read(file: string, library: boolean): string;
      publish(name: string, data: any): void;
      log(...args: any[]): void;
      event?(name: string, data: any): void;
      currentPage?(): any;
    },
  ) {
    const owner = this;
    class Value {
      private promise: Promise<any>;
      private resolve!: (v?: any) => void;
      private reject!: (error: any) => void;
      private done = false;
      constructor(private ownerId?: number) {
        this.promise = new Promise((r, reject) => {
          this.resolve = r;
          this.reject = reject;
        });
        // Some preallocated values are never consumed before shutdown.
        // Consumers are tracked separately; cancellation is still observed.
        void this.promise.catch(() => {});
      }
      get() {
        // Observe the original adapter's asynchronous allocation continuation.
        // Its implementation does not return that promise to the caller.
        const thisValue = this;
        return {
          then(ok: any, fail?: any) {
            const next = thisValue.promise.then(ok, fail);
            owner.track(next, thisValue.ownerId);
            return next;
          },
        };
      }
      set(v?: any) {
        if (!this.done) {
          this.done = true;
          this.resolve(v);
        }
      }
      fail(error: any) {
        if (!this.done) {
          this.done = true;
          this.reject(error);
        }
      }
      isResolved() {
        return this.done;
      }
    }
    // A port deliberately has no document/window. Context globals remain in VM realms.
    class Context {
      id = ++owner.sequence;
      options: any;
      loaded: any;
      startTimeStampMs = Date.now();
      endTimeStampMs = 0;
      global: any;
      alive = true;
      private lifetime = new AbortController();
      private cancelReady!: () => void;
      constructor(options: any) {
        if (owner.closed) throw Error("CONTEXT_CLOSED: manager is closed");
        this.options = { ...options };
        const value = new Value(this.id);
        this.loaded = value;
        this.global = host.create(this.id, this.options);
        owner.live.set(this.id, this);
        const cancelled = new Promise<void>((resolve) => {
          this.cancelReady = resolve;
        });
        owner.track(
          Promise.resolve().then(async () => {
            if (!this.alive) return;
            try {
              // Closing a frame must settle allocation even if its host never
              // acknowledges initialization. Race keeps late rejection observed.
              await Promise.race([
                host.ready?.(this.id, this.lifetime.signal),
                cancelled,
              ]);
            } catch (error) {
              if (!this.alive) return;
              value.fail(error);
              owner.manager.delete(this.id);
              this.destroy();
              throw error;
            }
            if (!this.alive) return;
            this.endTimeStampMs = Date.now();
            value.set();
          }),
          this.id,
        );
      }
      get name() {
        return this.options.name;
      }
      assertLive() {
        if (!this.alive) throw Error(`CONTEXT_CLOSED: ${this.id}`);
      }
      rename(name: string) {
        this.assertLive();
        this.options.name = name;
      }
      init(options: any, descriptors = {}) {
        this.assertLive();
        Object.assign(this.global, options);
        Object.defineProperties(this.global, descriptors);
      }
      setGlobalEnv(options: any) {
        this.init(options);
      }
      eval(source: any) {
        this.assertLive();
        return host.evaluate(this.id, source);
      }
      destroy() {
        if (!this.alive) return;
        this.alive = false;
        owner.live.delete(this.id);
        this.lifetime.abort();
        this.cancelReady();
        try {
          host.dispose(this.id);
        } finally {
          // Release allocation waiters; the adapter's subsequent init is rejected.
          this.loaded.set();
        }
      }
    }
    const quietReporter = { report15814() {}, start18798Report() {} };
    const program: any = {
      reporterManager: quietReporter,
      wxConfig: config,
      preloadReady: Promise.resolve(),
      codeManager: {
        readLibSync: (f: string) => host.read(f, true),
        readCodeSync: (f: string) => host.read(f, false),
      },
      jsBridge: { subscribeHandler: host.publish },
      get navigator() {
        return { currentPage: host.currentPage?.() };
      },
    };
    const manager = officialModule(
      baselibDir,
      "./src/base/program/manager/context.ts",
      {
        "./src/base/program/index.ts": { getProgram: () => program },
        "./src/base/program/context/base.ts": { Context },
      },
    );
    this.provenance.push(manager.provenance);
    this.manager = program.contextManager = new manager.exports.default(
      program,
    );
    // Keep deletion (registry ownership) separate from physical destruction.
    const remove = this.manager.delete.bind(this.manager);
    this.manager.delete = (id: number) => {
      // The original delete only covers used entries. A failed preloaded
      // frame must also be removed from the unused pool before reuse.
      const context = remove(id) || owner.live.get(id);
      if (context)
        for (const [name, pending] of this.manager._unusedContexts) {
          if (pending === context) this.manager._unusedContexts.delete(name);
        }
      context?.destroy();
      return context;
    };
    const mainReady = new Value();
    this.cancelConfiguration = () =>
      mainReady.fail(Error("CONTEXT_CLOSED: configuration cancelled"));
    program.appserviceManager = { mainContextReady: mainReady };
    const loaded = officialModule(
      baselibDir,
      "./src/app/index/context/index.ts",
      {
        "./src/common/base/file.ts": {
          readLibSync: (f: string) => Buffer.from(host.read(f, true)),
        },
        "./src/common/base/config.ts": { wxConfig: config },
        "./src/app/index/index.tsx": program,
        "./src/common/base/logger/index.ts": {
          info: host.log,
          error: host.log,
          warn: host.log,
        },
        "./src/common/base/eval.ts": {
          CodeType: { lib: "lib", usr: "usr", inline: "inline" },
        },
        "./src/base/program/monkey-test/index.ts": class {
          constructor() {
            throw Error("Monkey test host is unavailable");
          }
        },
      },
    );
    this.provenance.push(loaded.provenance);
    this.api = loaded.exports.default;
    this.configurationReady = () => mainReady.set();
  }
  configurationReady: () => void;
  private track(promise: Promise<unknown>, contextId?: number) {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      (error) => {
        this.pending.delete(promise);
        this.errors.push(error);
        if (this.errors.length > 128) this.errors.shift();
        this.host.event?.("context-failed", {
          contextId,
          error: {
            name: (error as any)?.name,
            message: String((error as any)?.message || error),
            stack: (error as any)?.stack,
          },
        });
      },
    );
  }
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.errors.length) throw this.errors.shift();
  }
  createMain() {
    return this.manager.create({ name: "main" });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelConfiguration();
    const failures: unknown[] = [];
    for (const [id, context] of this.live) {
      try {
        this.manager.delete(id);
        context.destroy();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "CONTEXT_DISPOSE_FAILED");
  }
}

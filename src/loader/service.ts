import { officialModule } from "./official-module";

/** Official AppServiceManager drives preload -> full configuration -> ready.
 * Only frame creation/evaluation and code I/O are supplied by the worker host. */
export class OfficialServiceAdapter {
  readonly provenance;
  private manager: any;
  constructor(
    baselibDir: string,
    wxConfig: any,
    host: {
      evaluate(code: string, src?: string): unknown;
      read(file: string): string;
      initialize?(options: { isMainContext: boolean }): void;
      publish(name: string, data: any): void;
      log(...args: any[]): void;
      contextManager?: any;
    },
  ) {
    class AsyncValue {
      private resolve!: (v?: unknown) => void;
      private promise = new Promise((resolve) => {
        this.resolve = resolve;
      });
      get() {
        return this.promise;
      }
      set(v?: unknown) {
        this.resolve(v);
      }
    }
    const context = {
      loaded: { get: () => Promise.resolve() },
      init: (options: any) => host.initialize?.(options),
      eval: ({ code, src }: any) => host.evaluate(code, src),
    };
    const loaded = officialModule(
      baselibDir,
      "./src/app/index/context/main.ts",
      {
        "./src/common/base/config.ts": { wxConfig },
        "./src/common/base/logger/index.ts": {
          debug: host.log,
          error: host.log,
        },
        "./src/common/base/utils/async.ts": { AsyncValue },
        "./src/app/index/index.tsx": {
          contextManager: host.contextManager || { create: () => context },
          codeManager: { readLib: async (file: string) => host.read(file) },
          remoteDebugger: { isRemoteDebug: () => false },
          jsBridge: { subscribeHandler: host.publish },
        },
        "./src/common/base/eval.ts": {
          CodeType: { inline: "inline", lib: "lib" },
        },
      },
    );
    this.provenance = loaded.provenance;
    this.manager = new loaded.exports.default();
  }
  async preload() {
    await this.manager.preloadMainContext({});
    await this.manager.readPreloadCode();
    await this.manager.evalPreloadCode();
  }
  async configure() {
    await this.manager.initMainContext();
  }
}

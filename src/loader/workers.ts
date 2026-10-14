import { Worker } from "node:worker_threads";
import path from "node:path";
import { officialModule } from "./official-module";
import { safePath } from "./paths";
import { debugContext } from "../debug/context";

/** Original worker manager/protocol, with a Node worker replacing WebWorker. */
export class OfficialWorkers {
  readonly api: any;
  readonly provenance: any[] = [];
  private entries = new Map<number, any>();
  private closed = false;
  private config: any;
  private boundId?: string;
  private bindWaiters: {
    callback: Function;
    worker: { alive: boolean } | undefined;
  }[] = [];
  constructor(
    private options: {
      baselibDir: string;
      packageDir: string;
      bootstrap: string;
      config: any;
      analysis?: any;
      global(): any;
      systemInfo: any;
      native(
        workerId: number,
        publish: (name: string, data: any) => void,
      ): {
        invoke(
          name: string,
          args: any,
          privateArgs: any,
          reply: (value: any) => void,
        ): string | undefined;
        close(): void;
      };
      inspector(workerId: number, url: string): void;
      event(name: string, value: any): void;
      log(level: string, args: any[], context?: any): void;
    },
  ) {
    this.config = options.config;
    const owner = this,
      loaded = new Map<string, any>();
    let creatingWorker: NodeWorker | undefined;
    const load = (name: string, imports: any = {}) => {
      const module = officialModule(options.baselibDir, name, imports);
      owner.provenance.push(module.provenance);
      loaded.set(name, module.exports);
      return module.exports;
    };
    const eventModule = "./src/common/wmpf-meta/lib/EventEmitter.ts";
    const emitter = load(eventModule);
    // The official emitter catches listener exceptions. Wire its provided
    // error sink so these don't vanish into the extracted factory's console.
    emitter.EventEmitter.setOnError(
      (error: any, event: string, sender: any) => {
        const context = debugContext.getStore();
        const workerId = sender?.workerId ?? context?.workerId;
        options.event("worker-callback-error", {
          workerId,
          targetId: workerId === undefined ? undefined : `worker:${workerId}`,
          context,
          event,
          error: {
            name: error?.name,
            message: String(error?.message || error),
            stack: error?.stack,
          },
        });
      },
    );
    const workerModule = "./src/common/wmpf-meta/worker/WMPFWorker.ts";
    const core = load(workerModule, { [eventModule]: emitter });
    const utilsModule = "./src/common/wmpf-meta/worker/utils.ts";
    const apiModule = "./src/common/wmpf-meta/worker/apiList.ts";
    class NodeWorker extends core.WMPFWorker {
      thread: Worker;
      state = "starting";
      phase = "debugger-connecting";
      role = "auxiliary";
      files: string[] = [];
      alive = true;
      queue: any[] = [];
      backend: ReturnType<typeof options.native>;
      timer?: NodeJS.Timeout;
      ownerContext = { ...debugContext.getStore() };
      constructor() {
        super();
        if (owner.closed) throw Error("WORKER_CLOSED: manager is closed");
        this.thread = new Worker(options.bootstrap, {
          workerData: {
            baselibDir: options.baselibDir,
            packageDir: options.packageDir,
            analysis: options.analysis,
          },
        });
        this.backend = undefined as any;
        this.thread.on("message", (message) => {
          if (!this.alive) return;
          const identity = {
            workerId: this.workerId,
            targetId: `worker:${this.workerId}`,
            parentContextId: this.ownerContext.contextId,
          };
          if (message.kind === "inspector")
            options.inspector(this.workerId, message.url);
          else if (message.kind === "ready") {
            clearTimeout(this.timer);
            this.state = "ready";
            this.phase = "adapter-ready";
            options.event("worker-ready", identity);
            for (const m of this.queue.splice(0)) this.thread.postMessage(m);
          } else if (message.kind === "message") {
            debugContext.run({ ...message.context, ...identity }, () => {
              try {
                this.handleMessage(message.data);
              } catch (error) {
                this.reportError(error);
              }
            });
          } else if (message.kind === "log")
            options.log(message.level, message.value, {
              ...message.context,
              ...identity,
            });
          else if (message.kind === "error") {
            if (message.error?.file) {
              this.phase = "failed";
              this.state = "failed";
            }
            this.reportError(message.error);
          } else {
            if (message.kind === "script-ready") {
              this.files.push(message.file);
              this.phase = message.library ? "library-ready" : "code-ready";
            }
            options.event("worker-" + message.kind, {
              ...identity,
              ...message,
            });
          }
        });
        this.thread.on("error", (error) => {
          if (!this.alive) return;
          this.state = "failed";
          try {
            this.reportError(error);
          } finally {
            this.terminate();
          }
        });
        this.thread.on("exit", (code) => {
          if (this.alive) {
            this.state = "exited";
            this.terminate();
          }
          options.event("worker-exit", { workerId: this.workerId, code });
        });
        this.timer = setTimeout(() => {
          if (this.state !== "starting") return;
          this.reportError(
            Error(
              "WORKER_BOOT_TIMEOUT: debugger/bootstrap acknowledgement missing",
            ),
          );
          this.terminate();
        }, 15000);
        this.timer.unref();
      }
      reportError(error: any) {
        const identity = {
          workerId: this.workerId,
          targetId: `worker:${this.workerId}`,
          parentContextId: this.ownerContext.contextId,
        };
        const detail = (e: any) => ({
          name: e?.name || "Error",
          message: String(e?.message || e),
          stack: e?.stack,
          file: e?.file,
        });
        options.event("worker-error", { ...identity, error: detail(error) });
        try {
          this.handleError(error);
        } catch (callbackError) {
          // Browser event callback exceptions are reported without escaping
          // the Worker event dispatch into the entire app-service thread.
          options.event("worker-callback-error", {
            ...identity,
            error: detail(callbackError),
          });
        }
      }
      setId(id: number) {
        super.setId(id);
        owner.entries.set(id, this);
        this.backend = options.native(id, (name, data) => {
          if (this.alive) this.dispatchEvent(name, data);
        });
        options.event("worker-created", {
          workerId: id,
          targetId: `worker:${id}`,
          parentContextId: this.ownerContext.contextId,
        });
      }
      postMessage(data: any) {
        if (!this.alive) throw Error("WORKER_CLOSED: " + this.workerId);
        const message = {
          kind: "message",
          data,
          context: {
            ...debugContext.getStore(),
            workerId: this.workerId,
            targetId: `worker:${this.workerId}`,
          },
        };
        // WebWorker.postMessage clones synchronously, including while its
        // script is loading. Preserve that boundary across our boot barrier.
        if (this.state === "starting")
          this.queue.push(structuredClone(message));
        else this.thread.postMessage(message);
      }
      transformLibPath(file: string) {
        return `wxapp://lib/${file.replace(/^\//, "")}`;
      }
      init(
        libs: string[],
        type: string,
        preload: boolean,
        config: any,
        system: any,
      ) {
        this.role = type === "app" ? "business-worker" : "library-worker";
        return super.init(libs, type, preload, config, system);
      }
      transformAppPath(file: string) {
        return `wxapp://app/${file.replace(/^\//, "")}`;
      }
      invokeJSAPI(name: string, args: any, privateArgs: any, reply: any) {
        if (!this.alive) return;
        let replied = false;
        const done = (value: any) => {
          if (!this.alive || replied) return;
          replied = true;
          reply(value);
        };
        try {
          const result = this.backend.invoke(
            name,
            typeof args === "string" ? JSON.parse(args) : args,
            privateArgs,
            done,
          );
          if (result) done(JSON.parse(result));
        } catch (error: any) {
          done({ errMsg: `${name}:fail ${error.message}` });
        }
      }
      invokeForbiddenJSAPI(name: string, reply: any) {
        reply({ errMsg: `${name}:fail not supported` });
      }
      terminate() {
        if (!this.alive) return;
        this.alive = false;
        this.state = "destroyed";
        clearTimeout(this.timer);
        this.queue = [];
        owner.bindWaiters = owner.bindWaiters.filter(
          (waiter) => waiter.worker !== this,
        );
        try {
          this.backend?.close();
        } finally {
          // Resource cleanup failure cannot leave the execution thread live.
          void this.thread.terminate();
          owner.entries.delete(this.workerId);
          options.event("worker-destroyed", {
            workerId: this.workerId,
            targetId: `worker:${this.workerId}`,
          });
        }
      }
    }
    const apiFactory = load("./src/common/wmpf-meta/worker/WeixinWorker.ts", {
      [workerModule]: core,
      [utilsModule]: load(utilsModule),
      [apiModule]: load(apiModule),
    });
    const waiting = {
      getSync: () => {
        if (!owner.boundId) throw Error("WORKER_APP_NOT_BOUND");
        return owner.boundId;
      },
      get isPending() {
        return !owner.boundId;
      },
      onReady: (callback: Function) => {
        const worker = creatingWorker;
        if (worker && !worker.alive) return;
        if (owner.boundId) callback(owner.boundId);
        else owner.bindWaiters.push({ callback, worker });
      },
    };
    this.api = apiFactory.createWeixinWorkerObject({
      createWorker: () => (creatingWorker = new NodeWorker()),
      get global() {
        return options.global();
      },
      get wxConfig() {
        return owner.config;
      },
      initalSystemInfo: options.systemInfo,
      waitingBindApp: waiting,
      waitingSplashAdWorker: { set() {} },
    });
    for (const [method, library] of [
      ["create", false],
      ["createWXLibWorker", true],
    ] as const) {
      const original = this.api[method];
      this.api[method] = (file: string, args: any = library ? "{}" : {}) => {
        if (owner.closed) throw Error("WORKER_CLOSED: manager is closed");
        safePath(library ? options.baselibDir : options.packageDir, file);
        const parsed = library ? JSON.parse(args) : args;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          (parsed.APIList !== undefined &&
            (!Array.isArray(parsed.APIList) ||
              parsed.APIList.some((name: unknown) => typeof name !== "string")))
        )
          throw TypeError(
            "WORKER_OPTIONS_INVALID: APIList must be an array of API names",
          );
        if (owner.entries.size >= 32) throw Error("WORKER_LIMIT_REACHED");
        if (!library && !owner.boundId) throw Error("WORKER_APP_NOT_BOUND");
        const previous = creatingWorker;
        creatingWorker = undefined;
        try {
          return original(file, args);
        } catch (error) {
          // A native backend or structured clone may fail after addWorker.
          const failed = creatingWorker as NodeWorker | undefined;
          if (failed) this.api.terminate(failed.workerId);
          throw error;
        } finally {
          creatingWorker = previous;
        }
      };
    }
  }
  bind(appid: string, config: any) {
    if (this.closed) throw Error("WORKER_CLOSED: manager is closed");
    this.config = config;
    this.boundId = appid;
    const failures: unknown[] = [];
    for (const { callback, worker } of this.bindWaiters.splice(0)) {
      if (worker && !worker.alive) continue;
      try {
        callback(appid);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "WORKER_BIND_FAILED");
  }
  continue(id: number) {
    const entry = this.entries.get(id);
    if (!entry?.alive) return;
    entry.thread.postMessage({ kind: "continue", workerId: id });
  }
  snapshot() {
    return [...this.entries].map(([id, e]) => ({
      workerId: id,
      targetId: `worker:${id}`,
      state: e.state,
      phase: e.phase,
      role: e.role,
      files: e.files,
      parentContextId: e.ownerContext.contextId,
    }));
  }
  closeContext(id: number) {
    this.terminateEntries((e) => e.ownerContext.contextId === id);
  }
  close() {
    this.closed = true;
    this.bindWaiters = [];
    this.terminateEntries(() => true);
  }
  private terminateEntries(matches: (entry: any) => boolean) {
    const failures: unknown[] = [];
    for (const e of this.entries.values())
      if (matches(e)) {
        try {
          this.api.terminate(e.workerId);
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length)
      throw new AggregateError(failures, "WORKER_DISPOSE_FAILED");
  }
}

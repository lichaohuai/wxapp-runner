import { EventEmitter } from "node:events";
import { officialModule } from "./official-module";

/** Official page ownership/routing, with an Electron surface port replacing the
 * React/frame container and XWeb layouter. The supplied module sources stay intact. */
export class OfficialPages {
  readonly provenance: any[] = [];
  readonly manager: any;
  readonly navigator: any;
  private pages = new Map<number, any>();
  private leases = new Set<any>();
  private routeSent = false;
  private closed = false;
  private preloading?: Promise<void>;
  constructor(
    baselibDir: string,
    config: any,
    private host: {
      create(): Promise<any>;
      prepare(rawPath: string): Promise<void>;
      load(page: any, rawPath: string): void;
      remove(page: any): void | Promise<void>;
      show(page: any, visible: boolean): void | Promise<void>;
      changed(pages: any[], tabs: any[]): void;
      event(name: string, data: any): void;
      back(page: any, delta: number): number | Promise<number>;
      modal(options: any): Promise<any>;
      log(...args: any[]): void;
    },
  ) {
    config = { ...config, page: config.page || {} };
    const globals = { setTimeout, clearTimeout, URLSearchParams, console };
    const load = (id: string, imports: any = {}) => {
      const m = officialModule(baselibDir, id, imports, globals);
      this.provenance.push(m.provenance);
      return m.exports;
    };
    const logger = { info: host.log, warn: host.log, error: host.log };
    const async = load("./src/common/base/utils/async.ts");
    const owner = this;
    class Queue extends async.AsyncQueue {
      async requestTask(timeout?: number) {
        const lease = await super.requestTask(timeout);
        let ended = false;
        const tracked = {
          done() {
            if (!ended) {
              ended = true;
              owner.leases.delete(tracked);
              lease.done();
            }
          },
        };
        owner.leases.add(tracked);
        return tracked;
      }
    }
    const route = load("./src/common/base/route.ts");
    const program: any = {
      wxConfig: config,
      features: { supportParallelMode: false, supportAdaptiveDragScale: false },
      reporterManager: { report15813() {}, report32044() {} },
      xWebBinding: {
        notifyEvent(name: string, data: any) {
          host.event(name, data);
        },
      },
      codeManager: {
        statCodeSync() {
          return { size: 0 };
        },
      },
      getSystemComponent(name: string) {
        if (name === "toast") return { hideToast() {} };
        if (name === "modalDialog") return { showModal: host.modal };
        throw Error("PAGE_HOST_COMPONENT_UNAVAILABLE: " + name);
      },
      jsBridge: {
        subscribeHandler: (name: string, data: any) => {
          if (name === "onAppRoute") this.routeSent = true;
          host.event(name, data);
        },
      },
    };
    const Abstract = load("./src/app/index/navigator/abstract.ts", {
      "../../node_modules/.pnpm/eventemitter3@4.0.7/node_modules/eventemitter3/index.js":
        EventEmitter,
      "./src/common/base/logger/index.ts": logger,
      "./src/base/program/index.ts": { getProgram: () => program },
      "./src/common/base/route.ts": route,
    });
    const decorator = load("./src/common/base/utils/decorator.ts", {
      "./src/common/base/logger/index.ts": logger,
    });
    const Manager = load("./src/app/index/manager/page.ts", {
      "./src/common/base/utils/async.ts": { ...async, AsyncQueue: Queue },
      "./src/common/base/logger/index.ts": logger,
      "./src/app/index/index.tsx": program,
    });
    this.manager = program.pageManager = new Manager.default({
      createPage: async () => {
        if (this.closed) throw Error("PAGE_MANAGER_CLOSED");
        const page = await host.create();
        if (this.closed) {
          await host.remove(page);
          throw Error("PAGE_MANAGER_CLOSED");
        }
        page.inited = new async.AsyncValue();
        page.loaded = new async.AsyncValue();
        page.readyed = new async.AsyncValue();
        // Every pending acknowledgement is also observed by the host, including
        // an error before the official navigator reaches its await expression.
        for (const value of [page.loaded, page.readyed])
          void value.get().catch(() => {});
        page.toggle = (visible: boolean) => host.show(page, visible);
        page.channel = {
          send: (name: string, data: any) => {
            if (name === "try_webview_goback")
              return host.back(page, data.delta);
            if (name === "focus")
              return page.surface?.view?.webContents?.focus();
            throw Error("PAGE_CHANNEL_UNAVAILABLE: " + name);
          },
        };
        page.load = (rawPath: string) => {
          if (page.rawPath) throw Error("PAGE_ALREADY_BOUND");
          const parsed = route.parsePath(rawPath);
          page.rawPath = rawPath;
          page.path = parsed.path;
          page.isTabBarPage = this.isTab(config, page.path);
          page.inited.set();
          try {
            host.load(page, rawPath);
          } catch (error) {
            this.fail(page.id, error);
          }
          const pending = page.loaded.get();
          void pending.catch(() => {});
          return pending;
        };
        this.pages.set(page.id, page);
        return page;
      },
      removePage: async (page: any) => {
        this.pages.delete(page.id);
        await host.remove(page);
      },
      getAllPage: () =>
        [...this.pages.values()].map((page) => ({
          id: page.id,
          ref: { currentSync: page },
        })),
    });
    class Layout {
      type = "default";
      constructor(public navigator: any) {}
      async init() {}
      async push(old: any, page: any) {
        await page.toggle(true);
        await old?.toggle(false);
      }
      async pop(old: any, page: any) {
        await page.toggle(true);
        await old?.toggle(false);
      }
      async switch(old: any, page: any) {
        await old?.toggle(false);
        await page.toggle(true);
      }
      async switchTab(page: any) {
        await page.toggle(true);
      }
      async reLaunch(page: any) {
        await page.toggle(true);
      }
    }
    class Parallel {
      constructor() {
        throw Error("PARALLEL_LAYOUT_UNAVAILABLE");
      }
    }
    const Navigator = load("./src/app/index/navigator/normal.ts", {
      "./src/common/base/route.ts": route,
      "./src/common/base/utils/decorator.ts": decorator,
      "./src/app/index/index.tsx": program,
      "./src/common/base/utils/async.ts": { ...async, AsyncQueue: Queue },
      "./src/app/index/util/index.ts": {
        isTabBar: (p: string) => this.isTab(config, p),
      },
      "./src/common/base/logger/index.ts": logger,
      "./src/app/index/navigator/abstract.ts": Abstract,
      "./src/app/index/navigator/layouter/default.ts": Layout,
      "./src/app/index/navigator/layouter/parallel.ts": Parallel,
      "./src/common/base/permission.ts": { innerCheckPermission: () => false },
      "./src/app/index/jsapi/initialRenderingCache.ts": {
        getInitialRenderingCache: () => undefined,
      },
    });
    this.navigator = program.navigator = new Navigator.default();
    this.navigator.on("beforeRoute", () =>
      host.changed(
        [...this.navigator.pageStack],
        [...this.navigator.tabBarPages],
      ),
    );
    this.manager.init();
  }
  private isTab(config: any, path: string) {
    return !!config.tabBar?.list?.some(
      (p: any) =>
        p.pagePath.replace(/\.html$/, "") ===
        path
          .split("?")[0]
          .replace(/^\//, "")
          .replace(/\.html$/, ""),
    );
  }
  get(id: number) {
    return this.pages.get(id);
  }
  acknowledge(id: number, stage: "loaded" | "readyed") {
    const page = this.pages.get(id);
    if (page && page[stage].isPending()) page[stage].set();
  }
  fail(id: number, error: any) {
    const page = this.pages.get(id);
    if (!page) return;
    page.failure = error;
    // loaded is the error-bearing acknowledgement. The SDK races readyed
    // against its transition deadline before awaiting loaded; rejecting both
    // would leave that unused race rejected after a failed load.
    if (page.loaded.isPending()) page.loaded.set(error, true);
  }
  async navigate(name: string, path?: string, delta = 1, routeId?: any) {
    if (this.closed) throw Error("PAGE_MANAGER_CLOSED");
    const nav = this.navigator;
    // Preflight precedes original stack mutations; failure leaves the old page.
    if (name !== "navigateBack")
      await this.host.prepare(path || nav.launchPath);
    const before = [...nav.pageStack],
      tabs = [...nav.tabBarPages],
      ids = new Set(this.pages.keys()),
      reserved = new Set(
        this.manager.getAllPreloadPage().map((p: any) => p.id),
      );
    this.routeSent = false;
    try {
      if (name === "appLaunch") await nav.appLaunch();
      else if (name === "navigateBack") await nav.navigateBack(delta, routeId);
      else if (
        ["navigateTo", "redirectTo", "switchTab", "reLaunch"].includes(name)
      )
        await nav[name](path, routeId);
      else throw Error("NAVIGATION_ACTION_INVALID");
      if (nav.currentPage?.failure) throw nav.currentPage.failure;
      this.host.changed([...nav.pageStack], [...nav.tabBarPages]);
      return {};
    } catch (error) {
      // An emitted business route cannot be undone. Before emission, rollback
      // only host ownership and discard the failed surface; never rerun scripts.
      if (!this.routeSent) {
        nav.pageStack = before;
        nav.tabBarPages = tabs;
        await this.manager.remove(
          [...this.pages.values()].filter(
            (p) =>
              !ids.has(p.id) ||
              (p.failure && !before.includes(p)) ||
              (reserved.has(p.id) &&
                !this.manager.getAllPreloadPage().includes(p)),
          ),
        );
        this.host.changed(before, tabs);
        await before.at(-1)?.toggle(true);
      }
      throw error;
    } finally {
      // The original module has no finally on host failures. Release only this
      // serialized operation's leases so one failed load cannot wedge navigation.
      for (const lease of [...this.leases]) lease.done();
    }
  }
  async preload(evalCode = false) {
    if (this.closed) return;
    if (this.preloading) {
      await this.preloading;
      if (evalCode && !this.closed)
        await Promise.all(
          this.manager.getAllPreloadPage().map((p: any) => p.evalPreloadCode()),
        );
      return;
    }
    const ids = new Set(this.pages.keys());
    const pending = this.manager.preload({ evalCode });
    this.preloading = pending;
    try {
      await pending;
    } catch (error) {
      await this.manager.remove(
        [...this.pages.values()].filter((p) => !ids.has(p.id)),
      );
      throw error;
    } finally {
      if (this.preloading === pending) this.preloading = undefined;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.navigator.cancelPageNotFoundTimer();
    for (const page of this.pages.values())
      this.fail(page.id, Error("PAGE_MANAGER_CLOSED"));
    await this.manager.remove([...this.pages.values()]);
    for (const lease of [...this.leases]) lease.done();
  }
}

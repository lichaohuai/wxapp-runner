import { AsyncLocalStorage } from "node:async_hooks";
import { officialModule } from "./official-module";

export const pageUiApis = new Set([
  "setNavigationBarTitle",
  "setNavigationBarColor",
  "showNavigationBarLoading",
  "hideNavigationBarLoading",
  "hideHomeButton",
  "showShareMenu",
  "showShareMenuWithShareTicket",
  "hideShareMenu",
  "showShareTimelineMenu",
  "hideShareTimelineMenu",
  "updateShareMenuShareTicket",
]);

/** Original PC state transitions; Electron supplies only the page and menu ports.
 * Bind each invocation across awaits so a late callback cannot change a new page. */
export class OfficialPageUi {
  readonly provenance: any[] = [];
  private scope = new AsyncLocalStorage<any>();
  private navbar: any;
  private share: any;
  constructor(
    baselibDir: string,
    private host: {
      alive(page: any): boolean;
      changed(page: any): void;
      log(...args: any[]): void;
    },
  ) {
    const load = (id: string, imports: any = {}) => {
      const m = officialModule(baselibDir, id, imports, {
        setTimeout,
        clearTimeout,
      });
      this.provenance.push(m.provenance);
      return m.exports;
    };
    const page = () => {
      const p = this.scope.getStore();
      if (!p || !host.alive(p))
        throw Error("PAGE_CLOSED: originating page closed");
      return p;
    };
    const program = {
      type: "app",
      wxConfig: {},
      features: {},
      navigator: {
        get currentPage() {
          return page().pageUi;
        },
      },
      get menuManager() {
        return page().pageUi.menu;
      },
      getComponent() {
        return page().pageUi.navbar;
      },
    };
    const logger = { info: host.log, warn: host.log, error: host.log };
    const decorator = load("./src/common/base/utils/decorator.ts", {
      "./src/common/base/logger/index.ts": logger,
    });
    this.navbar = load("./src/app/index/jsapi/navbar.ts", {
      "./src/common/base/logger/index.ts": logger,
      "./src/common/base/utils/decorator.ts": decorator,
      "./src/app/index/index.tsx": program,
    });
    this.share = load("./src/base/program/jsapi/share.ts", {
      "./src/common/base/logger/index.ts": logger,
      "./src/common/base/util.ts": { noop() {} },
      "./src/base/program/index.ts": { getProgram: () => program },
      "./src/common/base/utils/async.ts": load(
        "./src/common/base/utils/async.ts",
      ),
      "./src/common/base/binding/xweb.ts": {
        invokeSyncXWebJsApi() {
          host.changed(page());
        },
      },
    });
  }
  ensure(page: any, window: any = {}) {
    if (page.pageUi) return;
    const state = {
      navigationBarTitleText: "WxappRunner",
      navigationBarBackgroundColor: "#ffffff",
      navigationBarTextStyle: "black",
      showLoading: false,
      showHomeBtn: true,
      ...window,
    };
    page.pageUi = {
      id: page.id,
      pageWxConfig: { window: { ...window } },
      shareConfig: {
        showShareMenu: true,
        showShareTimelineMenu: false,
        withShareTicket: false,
      },
      navbar: {
        state,
        setState: (patch: any) => {
          if (!this.host.alive(page))
            throw Error("PAGE_CLOSED: originating page closed");
          Object.assign(state, patch);
          this.host.changed(page);
        },
      },
      menu: { updateMenu: () => this.host.changed(page) },
    };
  }
  snapshot(page: any) {
    return page?.pageUi
      ? {
          navigationBar: { ...page.pageUi.navbar.state },
          share: { ...page.pageUi.shareConfig },
          delivery: "local-preview-only",
        }
      : undefined;
  }
  async invoke(page: any, name: string, args: any = {}) {
    if (!pageUiApis.has(name)) throw Error("PAGE_UI_API_UNSUPPORTED: " + name);
    if (!this.host.alive(page))
      throw Error("PAGE_CLOSED: originating page closed");
    return this.scope.run(page, async () => {
      const Class = Object.values(this.navbar).find(
        (C: any) => typeof C === "function" && new C().name === name,
      ) as any;
      if (Class) return new Class().invoke(args);
      let result: any;
      await this.share[name](args, (r: any) => {
        result = r;
      });
      return result;
    });
  }
}

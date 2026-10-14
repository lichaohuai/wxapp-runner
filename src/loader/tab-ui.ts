import { officialModule } from "./official-module";

export const tabUiApis = new Set([
  "showTabBar",
  "hideTabBar",
  "setTabBarItem",
  "setTabBarStyle",
]);

/** Original PC JSAPI transitions. Component state is host-owned, distinct from
 * route membership; forceHide survives navigation exactly as in tabbar.tsx. */
export class OfficialTabUi {
  readonly provenance: any[] = [];
  private api: any;
  private component: any;
  constructor(
    baselibDir: string,
    config: any,
    private host: {
      alive(): boolean;
      changed(): void;
    },
  ) {
    const state = structuredClone(config || {});
    const check = () => {
      if (!host.alive()) throw Error("TARGET_CLOSED: tabBar host closed");
    };
    this.component = {
      state,
      hide: () => {
        check();
        state.forceHide = true;
        host.changed();
      },
      show: () => {
        check();
        state.forceHide = false;
        host.changed();
      },
      updateConfig: (patch: any) => {
        check();
        Object.assign(state, patch);
        host.changed();
      },
    };
    const load = (id: string, imports: any = {}) => {
      const m = officialModule(baselibDir, id, imports);
      this.provenance.push(m.provenance);
      return m.exports;
    };
    this.api = load("./src/app/index/jsapi/ui.ts", {
      "./src/common/base/config.ts": { wxConfig: { tabBar: config } },
      "./src/common/base/util.ts": { noop() {} },
      "./src/common/base/utils/async.ts": {},
      "./src/common/base/utils/deepClone.ts": load(
        "./src/common/base/utils/deepClone.ts",
      ),
      "./src/app/index/index.tsx": {
        // Created only after the shell configuration has arrived; subsequent
        // calls use the same ready component, never a timer-based barrier.
        preloadReady: Promise.resolve(),
        getComponent: (name: string) =>
          name === "tabBar" && config ? this.component : undefined,
      },
    });
  }
  get hidden() {
    return !!this.component.state.forceHide;
  }
  snapshot() {
    return structuredClone(this.component.state);
  }
  async invoke(name: string, args: any = {}) {
    if (!tabUiApis.has(name)) throw Error("TAB_UI_API_UNSUPPORTED: " + name);
    if (!this.host.alive()) throw Error("TARGET_CLOSED: tabBar host closed");
    let result: any;
    await this.api[name](args, (r: any) => {
      result = r;
    });
    return result;
  }
}

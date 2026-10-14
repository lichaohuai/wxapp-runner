import { debugContext, traceContext, copyDebug } from "./context";
import { RecordLog } from "../mcp/records";

/** Observes the real base-library instances; the base library still owns lifecycle/data semantics. */
export class DebugState {
  private ids = new WeakMap<object, string>();
  private instances = new Map<string, any>();
  private dataMethods = new WeakMap<
    object,
    { original: Function; wrapper: Function; active: boolean }
  >();
  private registrations: any[] = [];
  private sequence = 0;
  private events = new RecordLog<any>(500);
  constructor(
    private sub: any,
    private emit: (event: any) => void,
    private log: (...args: any[]) => void,
    private contextId: number | undefined = sub.WeixinJSContextId,
  ) {}
  private record(type: string, detail: any) {
    const snapshot = copyDebug(detail);
    const event = this.events.push({
      time: new Date().toISOString(),
      type,
      ...snapshot.value,
      truncated: snapshot.truncated,
      context: debugContext.getStore() || null,
    });
    this.emit(event);
    return event;
  }
  private pages(): any[] {
    return this.sub.internals?.__appServiceEngine__?.getCurrentPages() || [];
  }
  private registerInstance(instance: any, kind: string, file: string) {
    if (!instance || typeof instance !== "object") return undefined;
    const known = this.ids.get(instance);
    if (known) return this.instances.get(known);
    const id = `instance-${++this.sequence}`;
    const record = {
      id,
      kind,
      file,
      instance,
      createdAt: new Date().toISOString(),
      lastLifecycle: null,
      active: true,
      setDataObservation: {
        status: "unavailable",
        reason: "Instance has no setData",
      },
    };
    this.ids.set(instance, id);
    this.instances.set(id, record);
    if (typeof instance.setData === "function") {
      const original = instance.setData;
      const self = this;
      const method = {
        original,
        wrapper: undefined as unknown as Function,
        active: true,
      };
      const wrapper = function (
        this: any,
        patch: any,
        callback?: unknown,
        ...rest: any[]
      ) {
        if (!method.active)
          return original.call(this, patch, callback, ...rest);
        const before = copyDebug(this.data);
        const origin = debugContext.getStore();
        const change = self.record("setData", {
          instanceId: id,
          route: this.route || self.currentRoute(),
          patch,
          before: before.value,
          beforeTruncated: before.truncated,
          stack: new Error().stack,
        });
        try {
          // Leave invalid callbacks to the original API's validation/ignore
          // policy. Turning a boolean/options object into a callable changes
          // the base library's behaviour and can throw only after rendering.
          const observedCallback =
            callback === undefined || typeof callback === "function"
              ? function (this: any, ...args: any[]) {
                  return debugContext.run(origin || {}, () => {
                    self.record("setData-applied", {
                      instanceId: id,
                      changeId: change.id,
                      route: this.route || self.currentRoute(),
                    });
                    if (typeof callback === "function")
                      return Reflect.apply(callback, this, args);
                  });
                }
              : callback;
          const result = original.call(this, patch, observedCallback, ...rest);
          self.record("data", {
            instanceId: id,
            changeId: change.id,
            data: this.data,
          });
          return result;
        } catch (error) {
          self.record("exception", { phase: "setData", instanceId: id, error });
          throw error;
        }
      };
      method.wrapper = wrapper;
      try {
        if (!Reflect.set(instance, "setData", wrapper))
          throw Error("setData property is read-only");
        this.dataMethods.set(instance, method);
        record.setDataObservation = { status: "observed", reason: "" };
      } catch (error: any) {
        method.active = false;
        record.setDataObservation = {
          status: "unavailable",
          reason: String(error.message || error),
        };
        this.record("instrumentation-unavailable", {
          instanceId: id,
          method: "setData",
          phase: "install",
          reason: record.setDataObservation.reason,
        });
      }
    }
    return record;
  }
  private currentRoute() {
    return this.pages().at(-1)?.route || null;
  }
  install() {
    const self = this;
    for (const kind of ["App", "Page", "Component"]) {
      const original = this.sub[kind];
      this.sub[kind] = function (def: any) {
        const file =
          self.sub.__wxRoute ||
          self.sub.__wxAppCurrentFile__ ||
          (kind === "App" ? "app" : "unknown");
        self.log("REGISTER", kind, file);
        self.registrations.push({ kind, file });
        // Copy definition containers so instrumentation does not mutate a shared definition.
        const next = { ...def };
        if (def.methods) next.methods = { ...def.methods };
        if (def.lifetimes) next.lifetimes = { ...def.lifetimes };
        if (def.pageLifetimes) next.pageLifetimes = { ...def.pageLifetimes };
        const lifecycle =
          kind === "App"
            ? [
                "onLaunch",
                "onShow",
                "onHide",
                "onError",
                "onUnhandledRejection",
              ]
            : kind === "Page"
              ? ["onLoad", "onShow", "onReady", "onHide", "onUnload"]
              : ["created", "attached", "ready", "moved", "detached", "error"];
        const container = kind === "Component" ? (next.lifetimes ||= {}) : next;
        for (const name of lifecycle)
          if (typeof container[name] !== "function")
            container[name] =
              kind === "Component" && typeof def[name] === "function"
                ? def[name]
                : function () {};
        for (const group of [
          next,
          next.methods,
          next.lifetimes,
          next.pageLifetimes,
        ]) {
          if (!group) continue;
          for (const [name, fn] of Object.entries(group)) {
            if (typeof fn !== "function") continue;
            group[name] = function (...args: any[]) {
              const record = self.registerInstance(this, kind, file);
              const isLifecycle =
                lifecycle.includes(name) || group === next.pageLifetimes;
              const context = traceContext({
                contextId: self.contextId,
                instanceId: record?.id,
                route: this.route || self.currentRoute(),
                file,
                handler: name,
                kind: isLifecycle ? "lifecycle" : "method",
              });
              return debugContext.run(context, () => {
                if (record && isLifecycle) record.lastLifecycle = name;
                if (args[0]?.type)
                  self.log(
                    "HANDLER",
                    file,
                    name,
                    JSON.stringify(copyDebug(args[0], 8192).value),
                  );
                self.record(isLifecycle ? "lifecycle" : "handler", {
                  instanceId: record?.id,
                  name,
                  args,
                });
                try {
                  return fn.apply(this, args);
                } catch (error) {
                  self.record("exception", {
                    phase: name,
                    instanceId: record?.id,
                    error,
                  });
                  throw error;
                } finally {
                  if (record && ["detached", "onUnload"].includes(name)) {
                    record.active = false;
                    self.instances.delete(record.id);
                    self.ids.delete(this);
                    const method = self.dataMethods.get(this);
                    if (method) {
                      method.active = false;
                      try {
                        // Do not replace a method installed later by business
                        // code, or let a hardened property break onUnload.
                        if (
                          this.setData === method.wrapper &&
                          !Reflect.set(this, "setData", method.original)
                        )
                          throw Error("setData became read-only");
                      } catch (error: any) {
                        self.record("instrumentation-unavailable", {
                          instanceId: record.id,
                          method: "setData",
                          phase: "restore",
                          reason: String(error.message || error),
                        });
                      }
                    }
                    self.dataMethods.delete(this);
                  }
                }
              });
            };
          }
        }
        return original(next);
      };
      Object.assign(this.sub[kind], original);
    }
    this.sub.__runnerDebug = {
      device: (args: any) => this.sub.__runnerDeviceDebug(args),
      cloud: (args: any) => this.sub.__runnerCloudDebug(args),
      state: (args: any) => this.state(args),
      storage: (args: any) => this.storage(args),
    };
  }
  private domIdentity(instance: any) {
    const componentPath: string[] = [];
    const seen = new Set<any>();
    let current = instance;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (this.pages().includes(current))
        return {
          servicePageId: instance.getPageId?.() ?? current.getPageId?.(),
          pageStackIndex: this.pages().indexOf(current),
          route: current.route,
          componentPath,
        };
      if (!current.id || typeof current.selectOwnerComponent !== "function")
        return null;
      componentPath.unshift(String(current.id));
      current = current.selectOwnerComponent();
    }
    return null;
  }
  state(args: any) {
    if (args.action === "locate") {
      const item = this.instances.get(args.instanceId);
      if (!item) throw Error("Instance closed or not found");
      const query = this.sub.wx.createSelectorQuery().in(item.instance);
      return new Promise((resolve) =>
        query
          .selectAll(args.selector)
          .boundingClientRect((rects: any) =>
            resolve({
              instanceId: item.id,
              selector: args.selector,
              mapping: "public-scoped-selector-query",
              rects,
            }),
          )
          .exec(),
      );
    }
    if (args.action === "events")
      return this.events.page(args.after, args.limit);
    const pages = this.pages();
    for (const p of pages) this.registerInstance(p, "Page", p.route);
    if (args.action === "setData") {
      const item = this.instances.get(args.instanceId);
      if (!item) throw Error("Instance closed or not found");
      if (typeof item.instance.setData !== "function")
        throw Error("Instance has no setData");
      debugContext.run(
        traceContext({
          kind: "debug",
          handler: "runner_state.setData",
          instanceId: item.id,
        }),
        () => item.instance.setData(args.patch),
      );
      return { status: "setData-sent", businessCompleted: false };
    }
    const selected = args.instanceId
      ? [this.instances.get(args.instanceId)]
      : [...this.instances.values()];
    if (selected.some((v) => !v)) throw Error("Instance closed or not found");
    return {
      pages: pages.map((p) => ({
        instanceId: this.ids.get(p),
        route: p.route,
      })),
      registrations: this.registrations,
      instances: selected.map(({ instance, ...meta }) => {
        const data = copyDebug(instance.data),
          properties = copyDebug(instance.properties);
        let owner: any;
        try {
          owner = instance.selectOwnerComponent?.();
        } catch {}
        return {
          ...meta,
          route: instance.route || null,
          componentId: instance.id || null,
          domIdentity: this.domIdentity(instance),
          is: instance.is || null,
          ownerId: owner ? this.ids.get(owner) || null : null,
          ownerMapping:
            owner && this.ids.has(owner)
              ? "public-selectOwnerComponent"
              : "unavailable",
          data: data.value,
          dataTruncated: data.truncated,
          globalData:
            meta.kind === "App"
              ? copyDebug(instance.globalData).value
              : undefined,
          properties: properties.value,
          propertiesTruncated: properties.truncated,
        };
      }),
      latestEventId: this.events.page(0, 1).latestId,
    };
  }
  storage(args: any) {
    const wx = this.sub.wx;
    if (args.action === "set") wx.setStorageSync(args.key, args.value);
    else if (args.action === "remove") wx.removeStorageSync(args.key);
    else if (args.action === "clear") wx.clearStorageSync();
    if (["set", "remove", "clear"].includes(args.action))
      this.record("storage", {
        action: args.action,
        key: args.key,
        source: "debug",
      });
    const info = wx.getStorageInfoSync();
    const keys = args.key ? [args.key] : info.keys;
    const snapshot = copyDebug(
      Object.fromEntries(
        keys.map((key: string) => [key, wx.getStorageSync(key)]),
      ),
    );
    return { info, entries: snapshot.value, truncated: snapshot.truncated };
  }
}

import { copyDebug } from "../debug/context";
import { app, type BrowserWindow, type WebContents } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  setTimeout as hostTimeout,
  clearTimeout as clearHostTimeout,
} from "node:timers";
import { LogicInspector } from "./inspector";
import { parseTool } from "./tools";
import { redact } from "./redact";
import { WaitRegistry } from "./waits";
import { gesture, keyChord } from "./gestures";
import type { DialogController } from "../dialogs";
import { RecordLog } from "./records";
import { emitController } from "../controller/child";

type Host = {
  status: () => any;
  target: (target: string, targetId?: string) => WebContents;
  window: () => BrowserWindow;
  dialogs: DialogController;
  location: (value?: unknown, persist?: boolean) => any;
  navigate: (method: string, args: any) => Promise<any>;
};
// Validation failures are debugger results, never unhandled errors in the app view.
async function evaluateView(wc: WebContents, expression: string) {
  const result = await wc.executeJavaScript(
    `(async()=>{try{return {value:await (${expression})};}catch(error){return {debugError:{message:error.message,stack:error.stack}};}})()`,
  );
  if (result.debugError) throw Error(result.debugError.message);
  return result.value;
}
// Wait for the actual terminal DOM event before clearing operation context.
// sendInputEvent queues native input; executeJavaScript can otherwise overtake it.
function armInputReceipt(type: string) {
  let resolve!: (value: any) => void;
  const promise = new Promise((r) => (resolve = r));
  let received = false;
  const onEvent = (event: Event) => {
    if (!event.isTrusted) return;
    received = true;
    window.removeEventListener(type, onEvent, true);
    queueMicrotask(() => resolve({ type, received: true }));
  };
  window.addEventListener(type, onEvent, true);
  const timer = setTimeout(() => resolve({ type, received: false }), 5000);
  (globalThis as any).__runnerInputReceipt = promise;
  (globalThis as any).__runnerClearInputReceipt = () => {
    clearTimeout(timer);
    window.removeEventListener(type, onEvent, true);
    delete (globalThis as any).__runnerInputReceipt;
    delete (globalThis as any).__runnerClearInputReceipt;
  };
}
async function armReceipt(wc: WebContents, type: string) {
  await evaluateView(
    wc,
    `(${armInputReceipt.toString()})(${JSON.stringify(type)})`,
  );
}
async function inputReceipt(wc: WebContents) {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    evaluateView(wc, "globalThis.__runnerInputReceipt"),
    new Promise<undefined>((resolve) => {
      timer = hostTimeout(() => resolve(undefined), 6000);
    }),
  ]).finally(() => clearHostTimeout(timer));
  if (!result?.received)
    throw Object.assign(
      Error(
        "Native input was sent but its DOM event was not acknowledged; inspect state before retrying",
      ),
      { code: "INPUT_DELIVERY_UNKNOWN" },
    );
  return result;
}
// Executed exclusively in the view. It observes UI nodes and never loads business code.
function snapshotDOM(clientId = "legacy", prefix = "") {
  const nodes: Element[] = [];
  function scan(root: Document | ShadowRoot) {
    for (const node of root.querySelectorAll("*")) {
      nodes.push(node);
      if (node.shadowRoot) scan(node.shadowRoot);
    }
  }
  scan(document);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const selected = nodes
    .filter(
      (el) =>
        visible(el) &&
        (el.matches("input,textarea,button,a,[role=button]") ||
          (!el.children.length && !!el.textContent?.trim())),
    )
    .slice(0, 400);
  const map = new Map(selected.map((el, i) => [prefix + ":" + (i + 1), el]));
  const snapshots = ((globalThis as any).__runnerMcpSnapshots ||= new Map());
  snapshots.set(clientId, map);
  while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
  (globalThis as any).__runnerMcpSnapshot = map;
  return {
    text: document.body.innerText.slice(0, 30000),
    viewport: { width: innerWidth, height: innerHeight },
    elements: selected.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        nodeId: prefix + ":" + (i + 1),
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 300),
        value:
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.type === "password"
              ? "[REDACTED]"
              : el.value
            : undefined,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    }),
  };
}
async function locateDOM(args: any, input: boolean | string) {
  let el: Element | undefined;
  if (args.nodeId !== undefined)
    el = (globalThis as any).__runnerMcpSnapshots
      ?.get(args._clientId || "legacy")
      ?.get(args.nodeId);
  else {
    const matches: Element[] = [];
    function scan(root: Document | ShadowRoot) {
      for (const node of root.querySelectorAll("*")) {
        if (
          args.selector
            ? node.matches(args.selector)
            : !node.children.length && node.textContent?.trim() === args.text
        )
          matches.push(node);
        if (node.shadowRoot) scan(node.shadowRoot);
      }
    }
    scan(document);
    const visible = matches.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && getComputedStyle(e).visibility !== "hidden";
    });
    if (args.index !== undefined) {
      if (
        !Number.isInteger(args.index) ||
        args.index < 0 ||
        args.index >= visible.length
      )
        throw Error(
          `Locator matched ${visible.length} visible elements; index ${args.index} is out of range` +
            (visible.length
              ? ` (valid 0..${visible.length - 1})`
              : " (no elements matched)"),
        );
      el = visible[args.index];
    } else if (visible.length !== 1) {
      const candidates = visible.slice(0, 20).map((node, i) => {
        const rc = node.getBoundingClientRect();
        return {
          index: i,
          tag: node.tagName.toLowerCase(),
          text: node.textContent?.trim().slice(0, 80),
          rect: {
            x: Math.round(rc.x),
            y: Math.round(rc.y),
            width: Math.round(rc.width),
            height: Math.round(rc.height),
          },
        };
      });
      throw Error(
        visible.length === 0
          ? "Locator matched 0 visible elements; use a fresh snapshot nodeId"
          : `Locator matched ${visible.length} visible elements; re-issue the same locator with index 0..${visible.length - 1} to pick one (document order), or use a fresh snapshot nodeId. candidates=${JSON.stringify(candidates)}`,
      );
    } else el = visible[0];
  }
  if (!el?.isConnected) throw Error("Stale element; take a new snapshot");
  if (input === "inspect" || input === "highlight") {
    const r = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    if (input === "highlight") {
      const mark = document.createElement("div");
      mark.setAttribute("data-runner-highlight", "");
      Object.assign(mark.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483647",
        border: "2px solid #448aff",
        background: "#448aff22",
        left: r.x + "px",
        top: r.y + "px",
        width: r.width + "px",
        height: r.height + "px",
      });
      document.body.append(mark);
      setTimeout(() => mark.remove(), 1500);
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      ...("value" in el ? { value: (el as HTMLInputElement).value } : {}),
      attributes: Object.fromEntries(
        el.getAttributeNames().map((k) => [k, el!.getAttribute(k)]),
      ),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      html: el.outerHTML.slice(0, 20000),
      htmlTruncated: el.outerHTML.length > 20000,
      scroll: {
        left: el.scrollLeft,
        top: el.scrollTop,
        width: el.scrollWidth,
        height: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      },
      styles: Object.fromEntries(
        (
          args.computedStyles || [
            "display",
            "visibility",
            "position",
            "color",
            "font-size",
            "width",
            "height",
            "overflow",
            "z-index",
          ]
        ).map((k: string) => [k, style.getPropertyValue(k)]),
      ),
      mapping: (globalThis as any).__runnerDescribeComponent?.(
        el,
        args._componentDefinitions,
      ) || { status: "unknown", reason: "No component adapter" },
    };
  }
  const checkState = () => {
    for (
      let node: Element | null = el;
      node;
      node =
        node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null)
    ) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        (node === el && style.visibility === "hidden") ||
        Number(style.opacity) === 0 ||
        (node === el && style.pointerEvents === "none") ||
        node.hasAttribute("inert") ||
        node.getAttribute("aria-disabled") === "true"
      )
        throw Error("Target is not visible or enabled");
    }
    if ((el as HTMLButtonElement).disabled) throw Error("Target is disabled");
    if (input === true) {
      if (
        !(
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ) ||
        el.disabled ||
        el.readOnly ||
        (el instanceof HTMLInputElement &&
          ![
            "text",
            "number",
            "password",
            "email",
            "tel",
            "url",
            "search",
          ].includes(el.type))
      )
        throw Error("Target is not an editable native input/textarea");
    }
  };
  checkState();
  // Bringing the page process to the foreground can move a native input after
  // runner_wait completed. Observe the same element until stable, before any
  // focus/text/mouse dispatch. This is not a retry of a business operation.
  let before = el.getBoundingClientRect(),
    stableSince = performance.now();
  const deadline = stableSince + 1500;
  for (;;) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (!el.isConnected) throw Error("Stale element; take a new snapshot");
    const now = el.getBoundingClientRect(),
      time = performance.now();
    if (
      ["x", "y", "width", "height"].some(
        (key) => Math.abs((before as any)[key] - (now as any)[key]) > 0.5,
      )
    ) {
      before = now;
      stableSince = time;
    }
    if (time - stableSince >= 100) break;
    if (time >= deadline)
      throw Error(
        "Target is moving; wait for a stable element before sending input",
      );
  }
  checkState();
  const r = el.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height / 2);
  if (
    !r.width ||
    !r.height ||
    x < 0 ||
    y < 0 ||
    x >= innerWidth ||
    y >= innerHeight
  )
    throw Error("Target is outside the viewport");
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (
    !hit ||
    !(
      el === hit ||
      el.contains(hit) ||
      (hit !== document.body &&
        hit !== document.documentElement &&
        hit.contains(el))
    )
  )
    throw Error(
      "Target is covered by another element; wait for overlays to close and take a new snapshot",
    );
  if (input === true || input === "focus") {
    (el as HTMLElement).focus();
    if (input === true) (el as HTMLInputElement).select();
  }
  return { x, y };
}
function probeDOM(args: any) {
  let nodes: Element[] = [];
  if (args.nodeId) {
    const el = (globalThis as any).__runnerMcpSnapshots
      ?.get(args._clientId || "legacy")
      ?.get(args.nodeId);
    if (!el) throw Error("Stale element; take a new snapshot");
    nodes = [el];
  } else if (args.selector) {
    const scan = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(args.selector)) nodes.push(el);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(document);
  }
  const visible = (el: Element) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    for (
      let node: Element | null = el;
      node;
      node =
        node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null)
    ) {
      const s = getComputedStyle(node);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        Number(s.opacity) === 0
      )
        return false;
    }
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  };
  const shown = nodes.filter(visible);
  if (args.kind === "text")
    return {
      matched: document.body.innerText.includes(args.text),
      value: { text: args.text },
    };
  return {
    matched: args.kind === "hidden" ? shown.length === 0 : shown.length > 0,
    value: {
      count: shown.length,
      elements: shown.slice(0, 20).map((el) => ({
        tag: el.tagName,
        id: el.id,
        text: el.textContent?.slice(0, 1000),
        rect: {
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y,
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        },
      })),
    },
  };
}
export class RuntimeMcp {
  inspector = new LogicInspector();
  private server?: http.Server;
  private token = randomBytes(32).toString("hex");
  private file?: string;
  private logs = new RecordLog<any>(500);
  private requests = new Map<string, any>();
  private requestSequence = 0;
  private waits = new WaitRegistry();
  private activeInput = new Set<number>();
  constructor(private host: Host) {}
  log(source: string, args: any[], detail: any = {}) {
    // Official module decorators log returned VM Promises. IPC must never
    // receive those live objects (or throw back into an otherwise valid API).
    let captured;
    try { captured = copyDebug({ ...detail, args: args.slice(0, 20) }); }
    catch (error: any) {
      captured = { value: { args: ["[Unserializable log]"], captureError: String(error?.message || error) }, truncated: true };
    }
    const record = { source, ...captured.value, truncated: captured.truncated };
    emitController({ type: "log", ...record });
    return this.logs.push({ time: new Date().toISOString(), ...record });
  }
  network(record: any) {
    emitController({ type: "network", record });
    const cursor = Number(record.id);
    if (!this.requests.has(record.id) && cursor <= this.requestSequence) return;
    this.requestSequence = Math.max(cursor, this.requestSequence);
    this.requests.set(record.id, { ...record, cursor });
    while (this.requests.size > 100)
      this.requests.delete(this.requests.keys().next().value!);
  }
  async start(file: string) {
    this.file = file;
    this.server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (
        req.headers.origin ||
        req.headers.authorization !== `Bearer ${this.token}`
      ) {
        res.writeHead(403).end("{}");
        return;
      }
      if (req.method !== "POST" || req.url !== "/call") {
        res.writeHead(404).end("{}");
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw Error("Request too large");
          chunks.push(chunk);
        }
        const { name, arguments: args } = JSON.parse(
          Buffer.concat(chunks).toString(),
        );
        const cancel = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded) cancel.abort();
        };
        res.on("close", disconnected);
        let result: any;
        try {
          result = await this.dispatch(name, args, cancel.signal);
        } finally {
          res.off("close", disconnected);
        }
        res.end(JSON.stringify({ result }));
      } catch (e: any) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = "http://127.0.0.1:" + (this.server.address() as any).port;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        endpoint,
        token: this.token,
        appid: this.host.status().appid,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, file);
    console.log("MCP connection file:", file);
  }
  async dispatch(name: string, rawArgs: any, signal?: AbortSignal) {
    return this.call(name, parseTool(name, rawArgs), signal);
  }
  private async logicQuery(kind: string, args: any) {
    if (!this.host.status().serviceReady)
      throw Object.assign(
        Error(
          "Logic startup is not complete; wait for serviceReady before inspecting state",
        ),
        { code: "TARGET_NOT_READY" },
      );
    const result = await this.inspector.command("evaluate", {
      expression: `__runnerDebug.${kind}(${JSON.stringify(args)})`,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    const value = result.result?.value;
    if (kind === "state" && value?.instances)
      for (const item of value.instances) {
        const identity = item.domIdentity;
        if (!identity) continue;
        const page = this.host.status().stack?.[identity.pageStackIndex];
        item.domIdentity =
          page?.route === identity.route
            ? {
                ...identity,
                pageId: page.id,
                pageMapping: "verified-logic-and-host-page-stack",
              }
            : null;
      }
    return value;
  }
  private async wait(args: any, signal?: AbortSignal) {
    if (args.action === "cancel")
      return this.waits.cancel(args.waitId, args._clientId);
    if (args.action === "list") return this.waits.list(args._clientId);
    const after = args.after ?? this.requestSequence;
    let geometry = "",
      stableSince = 0;
    let view = ["element", "hidden", "text"].includes(args.kind)
      ? this.host.target(args.target, args.targetId)
      : undefined;
    if (view?.isDestroyed()) throw Error("Page closed");
    if (!view && args.nodeId)
      throw Error(
        "Snapshot target is no longer available; obtain a fresh snapshot",
      );
    return this.waits.run(
      args,
      async () => {
        if (args.kind === "route") {
          const route = this.host.status().current?.route;
          return {
            matched:
              route === args.route.replace(/^\//, "").replace(/\.html$/, ""),
            value: { route },
          };
        }
        if (args.kind === "network") {
          const record = [...this.requests.values()].find(
            (r) =>
              r.cursor > after &&
              (!args.urlIncludes || r.url.includes(args.urlIncludes)) &&
              (!args.method ||
                r.method.toUpperCase() === args.method.toUpperCase()) &&
              (!args.statusCode || r.status === args.statusCode) &&
              r.state === args.networkState,
          );
          if (record) return { matched: true, value: redact(record) };
          const oldest =
            this.requests.values().next().value?.cursor ||
            this.requestSequence + 1;
          if (after < oldest - 1)
            throw Error(
              "Network records were evicted after this cursor; inspect runner_network gap before continuing",
            );
          if (after > this.requestSequence)
            throw Error("Network cursor belongs to a different runtime");
          return { matched: false };
        }
        if (args.kind === "state") {
          const state = await this.logicQuery("state", {
            action: "get",
            instanceId: args.instanceId,
          });
          let value = state.instances[0].data;
          for (const key of args.path)
            value = value && Object.hasOwn(value, key) ? value[key] : undefined;
          return {
            matched: JSON.stringify(value) === JSON.stringify(args.equals),
            value: redact(value),
          };
        }
        if (args.kind === "dialog") {
          const value = this.host.dialogs
            .list()
            .find((d) => !args.dialogType || d.name === args.dialogType);
          return { matched: !!value, value };
        }
        // MCP becomes available before the initial page is created. An
        // unqualified selector/text wait may bind that first page once. After
        // binding, navigation/closure still invalidates it; never follow a
        // different page silently or reuse an old nodeId.
        if (!view) {
          view = this.host.target(args.target, args.targetId);
          if (!view) return { matched: false };
        }
        if (
          view.isDestroyed() ||
          view !== this.host.target(args.target, args.targetId)
        )
          throw Error(
            "Page closed or switched during wait; select the current page again",
          );
        const result = await evaluateView(
          view,
          `(${probeDOM.toString()})(${JSON.stringify(args)})`,
        );
        if (args.kind === "element" && result.matched && args.stableMs > 0) {
          const next = JSON.stringify(
            result.value.elements.map((e: any) => e.rect),
          );
          if (next !== geometry) {
            geometry = next;
            stableSince = performance.now();
          }
          if (performance.now() - stableSince < args.stableMs)
            return { matched: false };
        } else if (!result.matched) {
          geometry = "";
          stableSince = 0;
        }
        return result;
      },
      signal,
    );
  }
  private async call(name: string, args: any, signal?: AbortSignal) {
    if (name === "runner_wait") return this.wait(args, signal);
    if (name === "runner_dialog")
      return args.action === "list"
        ? this.host.dialogs.list()
        : this.host.dialogs.respond(args);
    if (name === "runner_status")
      return { ...this.host.status(), networkCursor: this.requestSequence };
    if (name === "runner_device")
      return args.action === "location"
        ? this.host.location(args.location, args.persist)
        : this.logicQuery("device", args);
    if (name === "runner_cloud") return this.logicQuery("cloud", args);
    if (name === "runner_native") {
      if (args.file) {
        if (!path.isAbsolute(args.file))
          throw Error("Image file path must be absolute");
        const ext = path
          .extname(args.file)
          .slice(1)
          .toLowerCase()
          .replace("jpg", "jpeg");
        if (!["png", "jpeg", "webp", "gif", "bmp"].includes(ext))
          throw Error("Unsupported camera image format");
        const stat = fs.statSync(args.file);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
          throw Error("Camera image must be a regular file of at most 16 MiB");
        args = {
          ...args,
          dataUrl:
            `data:image/${ext};base64,` +
            fs.readFileSync(args.file).toString("base64"),
        };
        delete args.file;
      }
      return evaluateView(
        this.host.target("page", args.targetId),
        `__runnerNative(${JSON.stringify(args)})`,
      );
    }
    if (name === "runner_state" && args.action === "location")
      return this.host.location(args.location, args.persist);
    if (name === "runner_state" || name === "runner_storage") {
      const result = await this.logicQuery(
        name === "runner_state" ? "state" : "storage",
        args,
      );
      if (name === "runner_state" && args.action === "locate") {
        const state = await this.logicQuery("state", { action: "list" });
        const identity = state.instances.find(
          (v: any) => v.id === args.instanceId,
        )?.domIdentity;
        const definitions = state.instances
          .filter((v: any) => v.kind === "Component")
          .map((v: any) => v.is);
        if (identity) {
          const wc = this.host.target("page");
          if (
            String(this.host.status().current?.id) === String(identity.pageId)
          )
            result.dom = await evaluateView(
              wc,
              `globalThis.__runnerLocateComponent(${JSON.stringify(identity)},${JSON.stringify(args._clientId || "legacy")},${JSON.stringify(definitions)})`,
            );
          else
            result.dom = {
              status: "unknown",
              reason: "Component belongs to an inactive page",
            };
        } else
          result.dom = {
            status: "unknown",
            reason: "Component has no confirmed scoped ID chain",
          };
      }
      return args.revealSensitive ? result : redact(result);
    }
    if (name === "runner_logs") return this.logs.page(args.after, args.limit);
    if (name === "runner_network") {
      // filter.* is declared in the schema and promised in the description, but
      // was never applied to list/after results (only runner_wait honoured it),
      // so every list came back unfiltered. Apply it in both paths.
      const f = args.filter || {};
      const matchesFilter = (r: any) =>
        (!f.urlIncludes || (r.url || "").includes(f.urlIncludes)) &&
        (!f.source || r.source === f.source) &&
        (!f.resourceType || r.resourceType === f.resourceType) &&
        (!f.state || r.state === f.state) &&
        (!f.blockedReason || r.blockedReason === f.blockedReason) &&
        (f.hasBody === undefined ||
          !!(r.requestBody || r.responseBody) === f.hasBody) &&
        (f.status === undefined ||
          (Array.isArray(f.status)
            ? f.status.includes(r.status)
            : r.status === f.status)) &&
        (!f.bodyIncludes ||
          ((r.requestBody || "") + (r.responseBody || "")).includes(
            f.bodyIncludes,
          ));
      if (args.after !== undefined && !args.id) {
        const rows = [...this.requests.values()]
          .filter((r) => r.cursor > args.after && matchesFilter(r))
          .sort((a, b) => a.cursor - b.cursor);
        const entries = rows
          .slice(0, args.limit)
          .map(({ requestBody, responseBody, ...rest }) => rest);
        const oldestCursor =
          this.requests.values().next().value?.cursor ||
          this.requestSequence + 1;
        const result = {
          entries,
          nextCursor: entries.at(-1)?.cursor ?? args.after,
          latestCursor: this.requestSequence,
          hasMore: rows.length > entries.length,
          oldestCursor,
          gap: args.after < oldestCursor - 1,
          cursorResetRequired: args.after > this.requestSequence,
        };
        return args.revealSensitive ? result : redact(result);
      }
      const result = args.id
        ? this.requests.get(args.id)
        : [...this.requests.values()]
            .filter(matchesFilter)
            .slice(-args.limit)
            .map(({ requestBody, responseBody, ...rest }) => rest);
      if (!result)
        throw Error(
          "Request not found or evicted; request cache retains 100 entries",
        );
      return args.revealSensitive ? result : redact(result);
    }
    if (["runner_evaluate", "runner_debugger"].includes(name) && args.targetId && args.targetId !== "logic")
      throw Object.assign(Error("This standalone endpoint only exposes the logic debugger; use the normal controller endpoint for page, H5 and Worker targets. No code was executed."), {code:"TARGET_UNSUPPORTED"});
    if (name === "runner_evaluate")
      return this.inspector.command("evaluate", args);
    if (name === "runner_debugger")
      return this.inspector.command(args.action, args);
    if (name === "runner_navigate") {
      if (
        args.targetId &&
        args.targetId !== "page:" + this.host.status().current?.id
      )
        throw Error("Navigation target is not the active page");
      return {
        ...(await this.host.navigate(args.method, {
          url: args.url,
          delta: args.delta,
        })),
        status: "route-sent",
        businessCompleted: false,
      };
    }
    const wc = this.host.target(args.target, args.targetId);
    if (!wc || wc.isDestroyed()) throw Error("No active view");
    if (name === "runner_dom") {
      const state = await this.logicQuery("state", { action: "list" });
      args._componentDefinitions = state.instances
        .filter((v: any) => v.kind === "Component")
        .map((v: any) => v.is);
      const result = await evaluateView(
        wc,
        `(${locateDOM.toString()})(${JSON.stringify(args)},${JSON.stringify(args.action)})`,
      );
      if (result.mapping?.status === "mapped") {
        const matches = state.instances.filter(
          (v: any) =>
            v.domIdentity &&
            String(v.domIdentity.pageId) === String(result.mapping.pageId) &&
            JSON.stringify(v.domIdentity.componentPath) ===
              JSON.stringify(result.mapping.componentPath),
        );
        result.mapping =
          matches.length === 1
            ? { ...result.mapping, instanceId: matches[0].id }
            : {
                ...result.mapping,
                status: "unknown",
                reason: `Owner chain matched ${matches.length} logic instances`,
              };
      }
      return args.revealSensitive ? result : redact(result);
    }
    if (name === "runner_snapshot")
      return evaluateView(
        wc,
        `(${snapshotDOM.toString()})(${JSON.stringify(args._clientId || "legacy")},${JSON.stringify(randomUUID())})`,
      );
    if (name === "runner_screenshot")
      return {
        image: (await wc.capturePage()).toPNG().toString("base64"),
        mimeType: "image/png",
      };
    if (!["runner_input", "runner_click", "runner_gesture"].includes(name))
      throw Error("Unknown tool");
    if (
      args.targetId &&
      args.targetId !== "page:" + this.host.status().current?.id &&
      !this.host.status().h5?.some((v: any)=>v.targetId===args.targetId && v.visible && v.pageId===this.host.status().current?.id)
    )
      throw Error(
        "Input target is not the active page; navigate or re-read status first",
      );
    const dialogPolicy = args.dialogPolicy || "error";
    const pending = this.host.dialogs.list();
    if (pending.length) {
      if (dialogPolicy === "error")
        throw Error(
          "A wx dialog is open; respond with runner_dialog before sending page input, or pass dialogPolicy:'auto-dismiss'/'auto-confirm'",
        );
      for (const d of pending) {
        const confirmable = d.name === "showModal" || d.name === "authorize";
        const response: any =
          dialogPolicy === "auto-confirm" && confirmable
            ? { id: d.id, confirm: true }
            : { id: d.id, cancel: true };
        try {
          // SAME path as runner_dialog -> original wx callback.
          this.host.dialogs.respond(response);
          this.log("operation", [], {
            type: "dialog-auto-response",
            dialog: { id: d.id, name: d.name },
            policy: dialogPolicy,
            answer: response.confirm ? "confirm" : "cancel",
            sideEffect:
              response.confirm && d.name === "authorize"
                ? "granted-app-permission"
                : response.confirm && d.name === "showModal"
                  ? "confirmed-business-modal"
                  : "none",
          });
        } catch (e: any) {
          if (!/closed|already answered/i.test(e?.message || "")) throw e;
        }
      }
      if (this.host.dialogs.list().length)
        throw Error(
          "A wx dialog is still open after auto-response; respond with runner_dialog before sending page input",
        );
    }
    if (this.activeInput.has(wc.id))
      throw Error(
        "Input is already in progress on this page; do not repeat the operation",
      );
    this.activeInput.add(wc.id);
    const operationId = args._operationId || randomUUID();
    const inputContext = {
      operationId,
      rootOperationId: operationId,
      clientId: args._clientId || "legacy",
    };
    try {
      await evaluateView(
        wc,
        `globalThis.__runnerInputContext=${JSON.stringify(inputContext)}`,
      );
      this.log("operation", [], {
        type: "input-dispatch",
        context: inputContext,
      });
      if (name === "runner_gesture") {
        if (args.action === "keys") keyChord(args.keys);
        const size = await evaluateView(
          wc,
          "({width:innerWidth,height:innerHeight})",
        );
        if (
          args.endX !== undefined &&
          (args.endX >= size.width || args.endY >= size.height)
        )
          throw Error("Gesture end is outside the viewport");
        const point =
          args.x !== undefined
            ? { x: Math.round(args.x), y: Math.round(args.y) }
            : args.nodeId || args.selector || args.text
              ? await evaluateView(
                  wc,
                  `(${locateDOM.toString()})(${JSON.stringify(args)},${JSON.stringify(["keys", "focus"].includes(args.action) ? "focus" : false)})`,
                )
              : {
                  x: Math.floor(size.width / 2),
                  y: Math.floor(size.height / 2),
                };
        if (point.x >= size.width || point.y >= size.height)
          throw Error("Target is outside the viewport");
        this.host.window().focus();
        wc.focus();
        if (args.action === "focus")
          return {
            operationId,
            status: "focus-sent",
            businessCompleted: false,
          };
        const receiptType =
          args.action === "keys"
            ? "keyup"
            : args.action === "scroll"
              ? "wheel"
              : args.action === "doubleclick"
                ? "dblclick"
                : "mouseup";
        const nativeShortcut =
          args.action === "keys" &&
          (args.keys.includes("F12") ||
            (args.keys.some((key: string) =>
              /^(cmd|command|meta|ctrl|control)$/i.test(key),
            ) &&
              args.keys.some((key: string) => /^(a|c|i)$/i.test(key))));
        if (!nativeShortcut) await armReceipt(wc, receiptType);
        const result = await gesture(wc, args, point);
        const receipt = nativeShortcut
          ? { type: "native-shortcut", received: null }
          : await inputReceipt(wc);
        return { ...result, operationId, receipt };
      }
      if (name === "runner_input") {
        // The page runs in a separate Electron process. On macOS selecting a
        // window alone may leave that process inactive behind native DevTools;
        // insertText still edits the DOM but no keyboard focus reaches baselib.
        // Re-focusing an already focused Electron child can blur a temporary
        // native keyboard editor. Preserve the focus established by the tap.
        if (!this.host.window().isFocused()) {
          app.focus({ steal: true });
          this.host.window().focus();
        }
        if (!wc.isFocused()) wc.focus();
        await evaluateView(
          wc,
          `(async()=>{const deadline=Date.now()+3000;while(!document.hasFocus()){if(Date.now()>deadline)throw Error("INPUT_FOCUS_FAILED: page did not acquire keyboard focus; no text was sent");await new Promise(r=>requestAnimationFrame(r));}})()`,
        );
        await evaluateView(
          wc,
          `(${locateDOM.toString()})(${JSON.stringify(args)},true)`,
        );
        // locateDOM has focused and selected the actual field. Refocusing the
        // host here can asynchronously blur it and close the base library's
        // keyboard gate before insertText delivers its trusted input event.
        await armReceipt(wc, args.text ? "input" : "keyup");
        if (args.text) await wc.insertText(args.text);
        else {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        }
        const receipt = await inputReceipt(wc);
        await evaluateView(wc, "document.activeElement?.blur()");
        return {
          operationId,
          inserted: true,
          receipt,
          status: "input-sent",
          businessCompleted: false,
        };
      }
      if (name === "runner_click") {
        const point =
          args.x !== undefined
            ? { x: Math.round(args.x), y: Math.round(args.y) }
            : await evaluateView(
                wc,
                `(${locateDOM.toString()})(${JSON.stringify(args)},false)`,
              );
        const size = await evaluateView(
          wc,
          "({width:innerWidth,height:innerHeight})",
        );
        if (
          point.x < 0 ||
          point.y < 0 ||
          point.x >= size.width ||
          point.y >= size.height
        )
          throw Error("Target is outside the viewport");
        this.host.window().focus();
        wc.focus();
        await armReceipt(wc, "click");
        wc.sendInputEvent({ type: "mouseMove", ...point });
        wc.sendInputEvent({
          type: "mouseDown",
          ...point,
          button: "left",
          clickCount: 1,
        });
        wc.sendInputEvent({
          type: "mouseUp",
          ...point,
          button: "left",
          clickCount: 1,
        });
        const receipt = await inputReceipt(wc);
        return {
          operationId,
          receipt,
          clicked: point,
          status: "input-sent",
          businessCompleted: false,
        };
      }
      throw Error("Unknown tool");
    } finally {
      // A paused or unresponsive renderer must not hold the control queue.
      // Conditional cleanup cannot erase a later operation's context.
      if (!wc.isDestroyed()) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          evaluateView(
            wc,
            `(()=>{if(globalThis.__runnerInputContext?.operationId===${JSON.stringify(operationId)}){globalThis.__runnerClearInputReceipt?.(); delete globalThis.__runnerInputContext}})()`,
          ).catch(() => {}),
          new Promise<void>((resolve) => {
            timer = hostTimeout(resolve, 1000);
          }),
        ]).finally(() => clearHostTimeout(timer));
      }
      this.activeInput.delete(wc.id);
    }
  }
  close() {
    this.waits.close();
    this.inspector.close();
    this.server?.close();
    try {
      if (
        this.file &&
        JSON.parse(fs.readFileSync(this.file, "utf8")).token === this.token
      )
        fs.unlinkSync(this.file);
    } catch {}
  }
}

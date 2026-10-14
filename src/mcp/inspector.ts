/** A Runtime/Debugger client only. Never consumes Node's destructive Network body cache. */
import { scheduledEvaluate } from "./scheduled-evaluate";
import WebSocket from "ws";
export class LogicInspector {
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private next = 0;
  private connected = false;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private pending = new Map<
    number,
    {
      resolve: Function;
      reject: Function;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  contexts = new Map<number, any>();
  scripts = new Map<string, any>();
  paused: any;
  readonly breakpoints = new Map<string, any>();
  private listeners = new Set<(method: string, params: any) => void>();
  subscribe(listener: (method: string, params: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get isConnected() {
    return this.connected;
  }
  private emit(method: string, params: any) {
    for (const fn of [this.onEvent, ...this.listeners]) {
      try {
        fn?.(method, params);
      } catch (e: any) {
        console.error("Inspector observer failed", {
          method,
          message: e.message,
        });
      }
    }
  }
  onEvent?: (method: string, params: any) => void;
  /**
   * Resolve once the logic VM is paused, or after `ms` if it never pauses.
   * The `Debugger.paused` CDP event arrives asynchronously after the action
   * that triggers it (a navigation/request that hits a breakpoint), so a
   * `frames`/`state` call issued immediately after triggering used to race the
   * event and wrongly report `paused:false`. Callers that expect a pause pass
   * `waitMs` to block for it instead of polling by hand.
   */
  private waitForPause(ms: number): Promise<void> {
    if (this.paused || !(ms > 0)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(finish, Math.min(ms, 60000));
      const off = this.subscribe((method: string) => {
        if (method === "Debugger.paused") finish();
      });
    });
  }
  connect(
    url: string,
    options: { reconnect?: boolean; onReconnect?: () => Promise<void> } = {},
  ) {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.ready = new Promise<void>((resolve, reject) => {
      // Use the Node protocol transport consistently in Node and Electron.
      // Electron's global WebSocket can abort live CDP response frames with
      // only an opaque ErrorEvent; ws also preserves transport diagnostics.
      const socket = (this.socket = new WebSocket(url, { perMessageDeflate: false }));
      socket.addEventListener("open", () => {
        if (socket !== this.socket || this.stopped) {
          socket.close();
          return;
        }
        this.connected = true;
        resolve();
      });
      socket.addEventListener("error", (event: any) => {
        if (socket !== this.socket || this.stopped) return;
        this.emit("Inspector.transportError", { message: String(event.message || event.error?.message || "Inspector WebSocket error").slice(0, 500) });
        reject(Error("Logic inspector connection failed"));
      });
      socket.addEventListener("close", (event) => {
        if (socket !== this.socket) return;
        this.connected = false;
        this.emit("Inspector.detached", { reason: "connection_closed", closeCode: event.code,
          closeReason: event.reason?.slice(0, 500), wasClean: event.wasClean });
        this.breakpoints.clear();
        reject(Error("Logic inspector disconnected"));
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(Error("Logic inspector disconnected"));
        }
        this.pending.clear();
        this.contexts.clear();
        this.scripts.clear();
        this.paused = undefined;
        if (options.reconnect && !this.stopped) {
          this.reconnectTimer = setTimeout(
            () => {
              if (this.stopped) return;
              void this.connect(url, options)
                .then(async () => {
                  await options.onReconnect?.();
                  this.reconnectAttempt = 0;
                  this.emit("Inspector.reconnected", {
                    observationGap: true,
                    operationsReplayed: false,
                  });
                })
                .catch(() => {
                  /* The close event schedules the next observation-only attempt. */
                });
            },
            Math.min(5000, 250 * 2 ** this.reconnectAttempt++),
          );
          this.reconnectTimer.unref();
        }
      });
      socket.addEventListener("message", (event) => {
        if (socket !== this.socket) return;
        const m = JSON.parse(String(event.data));

        if (m.id) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            if (m.error) {
              const changed =
                /Cannot find context|Execution context was destroyed|Cannot find default execution context|Cannot find unique context/i.test(
                  m.error.message,
                );
              p.reject(
                Object.assign(
                  Error(
                    changed
                      ? "Execution context changed during navigation. Read the target state again; the operation was not replayed."
                      : m.error.message,
                  ),
                  changed
                    ? { code: "CONTEXT_CHANGED", cause: m.error.message }
                    : {},
                ),
              );
            } else p.resolve(m.result);
          }
        } else if (m.method === "Runtime.executionContextCreated")
          this.contexts.set(m.params.context.id, m.params.context);
        else if (m.method === "Runtime.executionContextDestroyed")
          this.contexts.delete(m.params.executionContextId);
        else if (m.method === "Runtime.executionContextsCleared")
          this.contexts.clear();
        else if (m.method === "Debugger.scriptParsed")
          this.scripts.set(m.params.scriptId, m.params);
        else if (m.method === "Debugger.paused") {
          this.paused = m.params;
          // One-shot breakpoints: auto-remove on first hit so a breakpoint set
          // inside a hot VM dispatch loop can't re-pause every iteration and
          // wedge the thread. The pause itself still stands for inspection.
          for (const id of m.params.hitBreakpoints || []) {
            const bp = this.breakpoints.get(id);
            if (bp?.once) {
              this.breakpoints.delete(id);
              this.raw("Debugger.removeBreakpoint", { breakpointId: id }).catch(
                () => {},
              );
            }
          }
        }
        else if (m.method === "Debugger.resumed") this.paused = undefined;
        else if (m.method === "Debugger.breakpointResolved") {
          const bp = this.breakpoints.get(m.params.breakpointId);
          if (bp) bp.locations.push(m.params.location);
        }
        if (m.method) this.emit(m.method, m.params);
      });
    });
    this.ready = this.ready.then(async () => {
      await this.raw("Runtime.enable");
      await this.raw("Debugger.enable");
    });
    this.ready.catch(() => {});
    return this.ready;
  }
  raw(method: string, params: any = {}, timeoutMs = 10000) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Logic inspector disconnected"));
    return new Promise<any>((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            "Debugger command timed out; it may still execute. Check paused state before retrying.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async command(action: string, args: any) {
    if (!this.ready) throw Error("Logic inspector is not ready");
    await this.ready;
    if (!this.connected) throw Error("Logic inspector disconnected");
    if (action === "frames") {
      // Compact paused-frame reader. `state` embeds the full scope chain of
      // every call frame (60-75KB when paused deep in obfuscated code, over the
      // MCP token cap). Return only what a caller needs to act: reason, hit
      // breakpoints, and per-frame {index, functionName, callFrameId, location}
      // — enough to pick a callFrameId for evaluate. `limit` caps the frames.
      // `waitMs` blocks for a not-yet-delivered Debugger.paused event so a
      // frames call right after a trigger no longer races it into paused:false.
      if (!this.paused && args.waitMs) await this.waitForPause(args.waitMs);
      if (!this.paused) return { paused: false };
      const frames = (this.paused.callFrames || []).slice(
        0,
        args.limit || 40,
      );
      return {
        paused: true,
        reason: this.paused.reason,
        hitBreakpoints: this.paused.hitBreakpoints || [],
        frameCount: (this.paused.callFrames || []).length,
        frames: frames.map((f: any, i: number) => ({
          index: i,
          functionName: f.functionName || "",
          callFrameId: f.callFrameId,
          location: f.location,
          url: this.scripts.get(f.location?.scriptId)?.url,
        })),
      };
    }
    if (action === "state") {
      if (!this.paused && args.waitMs) await this.waitForPause(args.waitMs);
      // Full script metadata (hash/buildId/inline source maps/execution context)
      // is large — hundreds of scripts blow the response past the token cap.
      // Default to a compact projection (id/url/line-range); filter by
      // urlIncludes/scriptId and cap with limit; includeSourceMaps returns full.
      const allScripts = [...this.scripts.values()].filter(
        (s) =>
          s.url &&
          (!args.scriptId || s.scriptId === args.scriptId) &&
          (!args.urlIncludes || s.url.includes(args.urlIncludes)),
      );
      const shown = allScripts.slice(-(args.limit || 200));
      return {
        contexts: [...this.contexts.values()],
        scripts: shown.map((s) => {
          if (args.includeSourceMaps) return s;
          const base = {
            scriptId: s.scriptId,
            url: s.url,
            startLine: s.startLine,
            startColumn: s.startColumn,
            endLine: s.endLine,
            endColumn: s.endColumn,
          };
          // Preserve the data:-URL source-map omission contract (bytes + flag);
          // only drop the large hash/buildId/executionContext metadata.
          if (s.sourceMapURL?.startsWith("data:"))
            return {
              ...base,
              sourceMapAvailable: true,
              sourceMapBytes: Buffer.byteLength(s.sourceMapURL),
              sourceMapOmitted: true,
            };
          return { ...base, sourceMapAvailable: !!s.sourceMapURL };
        }),
        scriptsTotal: allScripts.length,
        scriptsShown: shown.length,
        paused: this.paused || null,
        breakpoints: [...this.breakpoints.values()],
      };
    }
    if (action === "evaluate") {
      let context =
        args.contextId ||
        [...this.contexts.values()].find((c) =>
          c.name.startsWith("Mini-program business") || c.name.startsWith("Mini-program worker"),
        )?.id ||
        (args.viewTarget
          ? [...this.contexts.values()].find((c) => c.auxData?.isDefault)?.id
          : undefined);
      if (args.viewTarget && !args.contextId && !args.callFrameId) {
        // Every iframe has a default world. Select the inspected page's main
        // frame, not the first iframe/default world left in the event cache.
        const tree = await this.raw("Page.getFrameTree");
        context = [...this.contexts.values()].find(
          (c) =>
            c.auxData?.isDefault &&
            c.auxData?.frameId === tree.frameTree?.frame.id,
        )?.id;
      }
      if (args.contextId && !this.contexts.has(args.contextId))
        throw Object.assign(
          Error(
            "Execution context is no longer available. Read target state again.",
          ),
          { code: "CONTEXT_CHANGED" },
        );
      if (!context && !args.callFrameId)
        throw Error("Business context is not ready");
      const selected = this.contexts.get(context);
      const params = {
        expression: args.expression,
        returnByValue: args.returnByValue !== false,
        objectGroup: "wxapp-debug",
        ...(args.callFrameId
          ? { callFrameId: args.callFrameId }
          : {
              // Numeric IDs can be reused when Chromium swaps renderer
              // processes. Never let an evaluation silently target a new world.
              ...(args.viewTarget && selected?.uniqueId
                ? { uniqueContextId: selected.uniqueId }
                : { contextId: context }),
              awaitPromise: !!args.awaitPromise,
              // Keep command deadlines in the controller. A V8 execution
              // timeout also terminates code stopped at a human breakpoint.
            }),
      };
      if (!args.callFrameId && !args.viewTarget && !this.paused) {
        const capability = await this.raw("Runtime.evaluate", {
          expression: "typeof __runnerScheduleEvaluation === 'function'",
          contextId: context,
          returnByValue: true,
          silent: true,
          disableBreaks: true,
        });
        if (capability.result?.value)
          return scheduledEvaluate(
            (method, params) => this.raw(method, params),
            params,
          );
      }
      return this.raw(
        args.callFrameId ? "Debugger.evaluateOnCallFrame" : "Runtime.evaluate",
        params,
      );
    }
    if (action === "breakpoints")
      return { breakpoints: [...this.breakpoints.values()] };
    if (action === "properties")
      return this.raw("Runtime.getProperties", {
        objectId: args.objectId,
        ownProperties: args.ownProperties !== false,
        generatePreview: true,
      });
    if (action === "releaseObjects")
      return this.raw("Runtime.releaseObjectGroup", {
        objectGroup: "wxapp-debug",
      });
    if (action === "exceptions")
      return this.raw("Debugger.setPauseOnExceptions", { state: args.state });
    if (action === "search") {
      const scripts = [...this.scripts.values()].filter(
        (s) => !args.urlIncludes || s.url.includes(args.urlIncludes),
      );
      if (!args.query)
        return {
          scripts: scripts.slice(0, args.limit || 100),
          truncated: scripts.length > (args.limit || 100),
        };
      const matches: any[] = [];
      let skippedScripts = 0;
      for (const script of scripts) {
        let result: any;
        try {
          result = await this.raw("Debugger.searchInContent", {
            scriptId: script.scriptId,
            query: args.query,
            caseSensitive: !!args.caseSensitive,
            isRegex: false,
          });
        } catch {
          // A script can be unloaded/evicted while still cached here; a stale
          // scriptId makes searchInContent throw "No script for id". Skip it
          // instead of failing the whole search.
          skippedScripts++;
          continue;
        }
        for (const match of result.result || []) {
          // query is literal (isRegex:false), so its column on the matched
          // line is a plain indexOf — exposing it lets setBreakpoint target a
          // specific function on a minified single-line script (crypto-js is
          // one physical line of ~30KB). -1 => not found on this line (V8 can
          // report a line whose content it trims); omit column then.
          const col =
            typeof match.lineContent === "string"
              ? match.lineContent.indexOf(args.query)
              : -1;
          matches.push({
            scriptId: script.scriptId,
            url: script.url,
            ...match,
            line: match.lineNumber + 1,
            ...(col >= 0 ? { column: col + 1 } : {}),
          });
          if (matches.length >= (args.limit || 100))
            return { matches, truncated: true, skippedScripts };
        }
      }
      return { matches, truncated: false, skippedScripts };
    }
    if (action === "source" && (args.line || args.around)) {
      // Windowed source: return only ±`around` lines around `line` instead of
      // the whole (often huge, formatted) script — pairs with search/frames
      // which report a one-based formatted line for a scriptId.
      const src = await this.raw("Debugger.getScriptSource", {
        scriptId: args.scriptId,
      });
      const lines = (src.scriptSource || "").split("\n");
      const around = args.around ?? 12;
      const center = args.line || 1;
      const from = Math.max(1, center - around);
      const to = Math.min(lines.length, center + around);
      return {
        scriptId: args.scriptId,
        line: center,
        from,
        to,
        totalLines: lines.length,
        windowed: from > 1 || to < lines.length,
        source: lines.slice(from - 1, to).join("\n"),
      };
    }
    const methods: Record<string, string> = {
      pause: "Debugger.pause",
      resume: "Debugger.resume",
      stepOver: "Debugger.stepOver",
      stepInto: "Debugger.stepInto",
      stepOut: "Debugger.stepOut",
      setBreakpoint: "Debugger.setBreakpointByUrl",
      removeBreakpoint: "Debugger.removeBreakpoint",
      source: "Debugger.getScriptSource",
    };
    if (!methods[action]) throw Error("Unknown debugger action");
    const result = await this.raw(
      methods[action],
      action === "setBreakpoint"
        ? {
            url: args.url,
            lineNumber: args.line - 1,
            columnNumber: (args.column || 1) - 1,
            condition: args.condition || "",
          }
        : action === "removeBreakpoint"
          ? { breakpointId: args.breakpointId }
          : action === "source"
            ? { scriptId: args.scriptId }
            : {},
    );
    if (action === "setBreakpoint")
      this.breakpoints.set(result.breakpointId, {
        ...args,
        ...result,
        locations: result.locations || [],
      });
    if (action === "removeBreakpoint")
      this.breakpoints.delete(args.breakpointId);
    return result;
  }
  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.connected = false;
    this.socket?.close();
  }
}

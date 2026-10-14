import { ContractCatalog } from "../contracts/query";
import { resolveLaunchTarget } from "../loader/launch-target";
import { ContractJobs } from "../contracts/jobs";
import { ExecutionExports } from "../analysis/execution/export";
import {
  AutopsyJobs,
  autopsyPreflight,
  type AutopsyOptions,
} from "../analysis/execution/autopsy";
import { analysisProtocolVersion } from "../analysis/protocol";
import { preflightExecution } from "../analysis/execution/host";
import { analysisConfig } from "../analysis/boot";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";
import { readConfig, wxConfig, hostPlatform, hostSystem } from "../config";
import { prepareHostContacts } from "../loader/contacts";
import { OfficialServiceAdapter } from "../loader/service";
import { OfficialContexts } from "../loader/contexts";
import { OfficialPages } from "../loader/pages";
import { OfficialWorkers } from "../loader/workers";
import { OfficialPackageAdapter } from "../loader/official";
import { inspectPackage } from "../loader";
import { parseTool } from "../mcp/tools";
import { redact } from "../mcp/redact";
import { LogicInspector } from "../mcp/inspector";
import {
  ControlQueue,
  independentControl,
  isRead,
  ControlError,
} from "./control";
import { EventStore } from "./events";
import { ArtifactStore } from "./artifacts";
import { captureRealtimeData, type RealtimeRecord } from "../native-components/realtime-data";
import { NetworkRules, changeRequest, ruleSchema } from "./rules";
import { CdpRelay } from "./cdp-relay";
import { ViewNetwork } from "./view-network";
import { debugLimitsSchema } from "../debug/limits";
import { SourceMaps } from "./source-maps";
import { captureContainer } from "./screenshots";
import { ProfileJobs } from "./profiles";
import { ProfileLock } from "./profile-lock";
import { exportNetworkSession } from "./network-export";
import { replayHeaders } from "./replay-headers";
import { WaitRegistry } from "../mcp/waits";
import { buildCatalog } from "../suite/catalog";
import { SuiteJobs } from "../suite/jobs";
import { callPackages } from "../packages/broker";
import { AnalysisTools } from "../analysis/tools";
import { projectRows } from "../analysis/projection";

type Runtime = {
  id: string;
  sessionId: string;
  config: any;
  state: string;
  status: any;
  process?: ChildProcess;
  inspector: LogicInspector;
  control: ControlQueue;
  views: Map<string, ViewNetwork>;
  workers: Map<string, LogicInspector>;
  logicSequence: number;
  rules: NetworkRules;
  requests: Map<string, any>;
  requestSequence: number;
  exit?: any;
  pending: Map<
    string,
    {
      resolve: Function;
      reject: Function;
      timer: NodeJS.Timeout;
      send?: () => void;
    }
  >;
  profileLock?: ProfileLock;
  keepProfileLock?: boolean;
};
export class DebugService {
  readonly runtimes = new Map<string, Runtime>();
  readonly events: EventStore;
  readonly limits: ReturnType<typeof debugLimitsSchema.parse>;
  private debuggerControls = new Map<string, ControlQueue>();
  private defaultId?: string;
  private server?: http.Server;
  private token = randomBytes(32).toString("hex");
  private files = new Set<string>();
  private closing = false;
  readonly artifacts: ArtifactStore;
  readonly relay: CdpRelay;
  readonly profiles: ProfileJobs;
  readonly sourceMaps: SourceMaps;
  private endpoint = "";
  private paused = new Map<string, any>();
  private cancelledRequests = new Map<string, number>();
  private waits = new WaitRegistry();
  private clients = new Map<string, number>();
  private heartbeat?: NodeJS.Timeout;
  private archives = new Map<string, Runtime>();
  private suites = new SuiteJobs();
  private contractJobs: ContractJobs;
  private contractCatalog: ContractCatalog;
  private executionExports = new ExecutionExports();
  private autopsies = new AutopsyJobs();
  private catalogs = new Map<string, ReturnType<typeof buildCatalog>>();
  constructor(
    private options: {
      root: string;
      userData: string;
      debug?: any;
      openDevtools: (id: string, url: string, targetId?: string) => void;
      updateDevtools?: (id: string, url: string, targetId: string) => void;
      removeNativeBreakpoint?: (
        id: string,
        targetId: string,
        record: any,
      ) => Promise<any>;
      onEvent?: (e: any) => void;
    },
  ) {
    this.contractCatalog = new ContractCatalog(path.resolve(options.root,".."));
    this.contractJobs = new ContractJobs(path.resolve(options.root,".."));
    this.limits = debugLimitsSchema.parse(options.debug || {});
    this.events = new EventStore(this.limits.eventLimit);
    this.artifacts = new ArtifactStore(
      path.join(options.userData, "debug", "artifacts"),
      this.limits.bodyLimit,
      this.limits.totalBodyLimit,
    );
    this.sourceMaps = new SourceMaps((id) => {
      const r = this.runtime(id);
      return [r.config.packageDir, r.config.baselibDir, options.root];
    });
    this.profiles = new ProfileJobs(this.artifacts, (job) =>
      this.events.push(job.runtimeId, job.sessionId, "profile", job),
    );
    this.relay = new CdpRelay({
      observed: (id, event) => {
        const r = this.runtime(id);
        if (event.sessionId !== r.sessionId) return;
        // Node Inspector reports session-specific pauses. Never expose a stale
        // MCP frame after a native frontend has stepped or resumed the isolate.
        if (["Debugger.paused", "Debugger.resumed"].includes(event.type)) {
          const target =
            event.targetId === "logic"
              ? r.inspector
              : r.workers.get(event.targetId) ||
                r.views.get(event.targetId)?.client;
          if (!target) return;
          target.paused = undefined;
        }
        if (event.type === "Debugger.resumed")
          this.relay.clearPaused(id, event.targetId);
        this.event(r, "native-devtools", event);
      },
      sourceMap: (id, script, map) => {
        const key = this.sourceMaps.register(id, script, map);
        return key
          ? this.endpoint + "/source-map/" + this.token + "/" + key
          : undefined;
      },
      records: (id) => [...this.runtime(id).requests.values()],
      body: (id, requestId, request, sessionId) => {
        const current = this.runtime(id),
          runtime =
            current.sessionId === sessionId
              ? current
              : this.archives.get(sessionId);
        if (!runtime || runtime.id !== id)
          throw new ControlError(
            "SESSION_CHANGED",
            "The body's diagnostic session was closed or does not belong to this runtime",
          );
        return this.protocolBody(runtime, requestId, request);
      },
      network: (id, method, args, target) =>
        this.protocolNetwork(this.runtime(id), method, args, target),
      human: (id, method, args) => {
        const r = this.runtime(id);
        r.control.manual();
        this.event(r, "control", { type: "native-devtools", method });
      },
    });
  }
  private event(r: Runtime, source: string, detail: any) {
    const event = this.events.push(r.id, r.sessionId, source, detail);
    this.options.onEvent?.(event);
    return event;
  }
  manual(runtimeId: string, detail: any) {
    const r = this.runtime(runtimeId);
    r.control.manual();
    this.event(r, "control", detail);
  }
  private runtime(id?: string) {
    const r = this.runtimes.get(id || this.defaultId || "");
    if (!r)
      throw new ControlError(
        "RUNTIME_NOT_FOUND",
        "No selected runtime; use runner_runtime start",
      );
    return r;
  }
  private target(r: Runtime, targetId = "logic") {
    const target =
      targetId === "logic"
        ? r.inspector
        : r.workers.get(targetId) || r.views.get(targetId)?.client;
    if (!target)
      throw new ControlError(
        "TARGET_NOT_FOUND",
        "Target is stale or belongs to another runtime",
      );
    return target;
  }
  private capabilities(targetId: string) {
    return {
      debugger: true,
      cpu: true,
      heap: true,
      allocations: true,
      trace: targetId !== "logic" && !targetId.startsWith("worker:"),
      sourceMaps: "existing script metadata only",
      breakpointScope: "client connection",
    };
  }
  private summary(r: Runtime) {
    return {
      runtimeId: r.id,
      sessionId: r.sessionId,
      appid: r.config.appid,
      appVersion: r.config.appVersion ?? 0,
      appVersionSource: r.config.appVersionSource || "unknown-native-zero",
      packageDir: r.config.packageDir,
      profile: r.config.profile || "default",
      loaderAdapter: r.config.loaderAdapter || "legacy",
      loaderProvenance: r.config.loaderProvenance,
      loaderHost: {
        platform:
          r.config.loaderAdapter === "legacy" ? "android" : hostPlatform,
        system: r.config.loaderAdapter === "legacy" ? "Android 14" : hostSystem,
      },
      analysis: {
        enabled: !!r.config.analysis?.enabled,
        defeatAntiHook: !!r.config.analysis?.defeatAntiHook,
        randomPinned: r.config.analysis?.randomSeed !== undefined,
        bootScript: !!r.config.analysis?.bootScript,
        networkMode: r.rules.experimentMode,
      },
      state: r.state,
      pid: r.process?.pid,
      exit: r.exit,
      ...r.status,
      contracts: { ...this.contractCatalog.status(r.config.baselibDir), observedGaps: r.status.loader?.nativeBoundary, observations: r.status.loader?.nativeContracts },
      networkCursor: r.requestSequence,
      targets: [
        {
          targetId: "logic",
          kind: "logic",
          connected: r.inspector.isConnected,
          capabilities: this.capabilities("logic"),
        },
        ...[...r.workers].map(([targetId, client]) => ({
          targetId,
          kind: "worker",
          connected: client.isConnected,
          parentTargetId: "logic",
          capabilities: this.capabilities(targetId),
        })),
        ...[...r.views].map(([targetId, view]) => ({
          targetId,
          kind: targetId.startsWith("h5:") ? "h5" : "view",
          parentTargetId: r.status.h5?.find((i: any) => i.targetId === targetId)
            ?.parentTargetId,
          connected: view.client.isConnected,
          capabilities: this.capabilities(targetId),
        })),
      ],
    };
  }
  async start(config: any, reuse?: Runtime) {
    // Preflight before stopping/replacing any live process.
    config = prepareHostContacts({ ...config, analysis: analysisConfig(config.analysis) });
    if (config.analysis.enabled && !config.profile)
      config.profile = "analysis-" + randomUUID().slice(0, 8);
    const plan = inspectPackage(config);
    if (!plan.startupReady)
      throw new ControlError(
        "PREFLIGHT_FAILED",
        plan.errors.map((e: any) => e.message).join("; "),
      );
    // Validate the supplied adapter before replacing a live process. Loading
    // the scheduler reads trusted library code, and never runs a business file.
    if (config.loaderAdapter === "official") {
      try {
        const adapter = new OfficialPackageAdapter(
          { ...config, wxConfig: wxConfig({ ...config, plan }) },
          {
            preparePackage: async () => {
              throw Error("No package execution during preflight");
            },
            publish() {},
            log() {},
          },
        );
        const service = new OfficialServiceAdapter(
          config.baselibDir,
          wxConfig({ ...config, plan }),
          {
            read() {
              throw Error("No execution in preflight");
            },
            evaluate() {},
            publish() {},
            log() {},
          },
        );
        const contexts = new OfficialContexts(
          config.baselibDir,
          wxConfig({ ...config, plan }),
          {
            create() {
              throw Error("No allocation during preflight");
            },
            evaluate() {
              throw Error("No execution during preflight");
            },
            read() {
              throw Error("No resource reads during preflight");
            },
            dispose() {},
            publish() {},
            log() {},
          },
        );
        const workers = new OfficialWorkers({
          ...config,
          bootstrap: "",
          config: wxConfig({ ...config, plan }),
          systemInfo: {},
          global() {
            throw Error("No globals during preflight");
          },
          native() {
            throw Error("No worker during preflight");
          },
          event() {},
          log() {},
          inspector() {},
        });
        const pages = new OfficialPages(
          config.baselibDir,
          wxConfig({ ...config, plan }),
          {
            async create() {
              throw Error("No allocation during preflight");
            },
            async prepare() {
              throw Error("No execution during preflight");
            },
            load() {},
            remove() {},
            show() {},
            changed() {},
            event() {},
            back(_page, delta) {
              return delta;
            },
            async modal() {
              throw Error("No dialog during preflight");
            },
            log() {},
          },
        );
        void pages.close();
        config.loaderProvenance = {
          ...adapter.provenance,
          service: service.provenance,
          pages: pages.provenance,
          contexts: contexts.provenance,
          workers: workers.provenance,
        };
        contexts.close();
        workers.close();
      } catch (e: any) {
        throw new ControlError("OFFICIAL_ADAPTER_UNAVAILABLE", e.message);
      }
    } else delete config.loaderProvenance;
    preflightExecution(
      config.packageDir,
      [
        ...new Set([
          ...plan.logicFiles,
          ...Object.values(plan.pages).flatMap((p) => p.logicFiles),
        ]),
      ].filter((file) => fs.existsSync(path.join(config.packageDir, file))),
      config.analysis.execution,
    );
    const dataRoot =
      config.persistentRoot || config.userDataDir || this.options.userData;
    let profile = config.profile || "default";
    if (
      [...this.runtimes.values()].some(
        (r) =>
          r !== reuse &&
          ["starting", "running", "failed"].includes(r.state) &&
          r.config.appid === config.appid &&
          r.config.persistentRoot === dataRoot &&
          r.config.profile === profile,
      )
    ) {
      if (config.profile)
        throw new ControlError(
          "PROFILE_IN_USE",
          "This app profile is already in use",
        );
      profile = "isolated-" + randomUUID().slice(0, 8);
    }
    const profilePath = () =>
      path.join(
        profile === "default"
          ? dataRoot
          : path.join(dataRoot, "profiles", profile),
        "apps",
        config.appid,
      );
    const previousLock = reuse?.profileLock;
    let lock: ProfileLock;
    if (
      previousLock &&
      !previousLock.released &&
      fs.existsSync(profilePath()) &&
      previousLock.file ===
        path.join(fs.realpathSync(profilePath()), ".runner-profile.lock")
    )
      lock = previousLock;
    else {
      try {
        lock = new ProfileLock(profilePath());
      } catch (e: any) {
        if (e.code !== "PROFILE_IN_USE" || config.profile) throw e;
        profile = "isolated-" + randomUUID().slice(0, 8);
        lock = new ProfileLock(profilePath());
      }
    }
    let starting: Runtime | undefined;
    try {
      if (reuse && ["starting", "running", "failed"].includes(reuse.state)) {
        reuse.keepProfileLock = lock === previousLock;
        await this.stop(reuse);
        reuse.keepProfileLock = false;
      }
      const r: Runtime = reuse || {
        id: randomUUID(),
        sessionId: "",
        config: {},
        state: "starting",
        status: {},
        inspector: new LogicInspector(),
        control: new ControlQueue(),
        views: new Map(),
        workers: new Map(),
        logicSequence: 0,
        rules: new NetworkRules(),
        requests: new Map(),
        requestSequence: 0,
        pending: new Map(),
      };
      if (reuse?.sessionId)
        this.archives.set(reuse.sessionId, {
          ...reuse,
          requests: new Map(reuse.requests),
          status: { ...reuse.status },
          views: new Map(),
          workers: new Map(),
        });
      if (reuse) r.inspector = new LogicInspector();
      starting = r;
      r.rules.experimentMode = config.analysis?.networkMode || "normal";
      r.profileLock = lock;
      r.sessionId = randomUUID();
      r.state = "starting";
      r.exit = undefined;
      r.status = {};
      r.requests.clear();
      r.requestSequence = 0;
      r.logicSequence = 0;
      for (const v of r.views.values()) v.close();
      r.views.clear();
      for (const worker of r.workers.values()) worker.close();
      r.workers.clear();
      const persistentRoot =
        profile === "default"
          ? dataRoot
          : path.join(dataRoot, "profiles", profile);
      r.config = {
        ...config,
        debug: this.limits,
        profile,
        persistentRoot: dataRoot,
        userDataDir: persistentRoot,
        chromiumDataDir: path.join(
          persistentRoot,
          "apps",
          config.appid,
          "browser",
        ),
        plan,
        runtimeId: r.id,
        sessionId: r.sessionId,
        mcp: false,
      };
      this.runtimes.set(r.id, r);
      this.defaultId ||= r.id;
      const tempDir = path.join(this.options.userData, "debug", "boot");
      fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      const bootFile = path.join(tempDir, r.sessionId + ".json");
      fs.writeFileSync(bootFile, JSON.stringify(r.config), { mode: 0o600 });
      const reservation = http.createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const debugPort = (reservation.address() as any).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        WXAPP_DEBUG_PORT: String(debugPort),
        WXAPP_RUNTIME_CHILD: "1",
        WXAPP_RUNTIME_CONFIG: bootFile,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.WXAPP_STANDALONE;
      const child = (r.process = spawn(
        process.execPath,
        [path.join(this.options.root, "main.cjs")],
        {
          cwd: process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "advanced",
        },
      ));
      lock.child(child.pid);
      const bootSession = r.sessionId;
      const decoders = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      };
      const lines = { stdout: "", stderr: "" };
      const flushOutput = (source: "stdout" | "stderr", final = false) => {
        const end = final
          ? lines[source].length
          : lines[source].lastIndexOf("\n") + 1;
        if (!end) return;
        const ready = lines[source].slice(0, end);
        lines[source] = lines[source].slice(end);
        // Child debugger banners are not endpoints or shutdown notices for the
        // controller. In particular, automation launchers parse these sentinels.
        const text = ready
          .replaceAll("Debugger listening on ", "Runtime V8 endpoint: ")
          .replaceAll("DevTools listening on ", "Runtime Chromium endpoint: ")
          .replaceAll(
            "Waiting for the debugger to disconnect",
            "Runtime debugger detach pending",
          );
        (source === "stderr" ? process.stderr : process.stdout).write(text);
      };
      const output = (source: "stdout" | "stderr", chunk: Buffer) => {
        const text = decoders[source].write(chunk);
        this.events.push(r.id, bootSession, source, {
          level: source === "stderr" ? "warn" : "info",
          args: [text.slice(0, 32000)],
        });
        lines[source] += text;
        flushOutput(source);
      };
      child.stdout?.on("data", (b) => output("stdout", b));
      child.stderr?.on("data", (b) => output("stderr", b));
      child.on("message", (m: any) => {
        if (r.process === child && r.sessionId === bootSession)
          void this.message(r, m).catch((e) =>
            this.events.push(r.id, bootSession, "controller", {
              level: "error",
              args: [{ message: e.message, stack: e.stack }],
            }),
          );
      });
      let exited = false;
      const onExit = (
        code: number | null,
        signal: string | null,
        error?: string,
      ) => {
        if (exited) return;
        exited = true;
        for (const source of ["stdout", "stderr"] as const) {
          lines[source] += decoders[source].end();
          flushOutput(source, true);
        }
        if (r.process !== child || r.sessionId !== bootSession) {
          lock.release();
          return;
        }
        if (!r.keepProfileLock) lock.release();
        r.state = "exited";
        r.exit = {
          code,
          signal,
          error,
          time: new Date().toISOString(),
          expected: !!this.closing || r.status.stopping === true,
        };
        r.inspector.close();
        for (const [id, worker] of r.workers) {
          worker.close();
          this.relay.unregister(r.id, id);
        }
        r.workers.clear();
        this.releasePaused(r.id);
        for (const [targetId, view] of r.views) {
          view.close();
          this.relay.unregister(r.id, targetId);
        }
        this.relay.unregister(r.id, "logic");
        for (const record of r.requests.values())
          if (["pending", "headers"].includes(record.state))
            this.recordNetwork(r, {
              ...record,
              state: "capture-error",
              captureError: "Runtime exited before completion was observed",
              completionUnknown: true,
              endedAt: new Date().toISOString(),
            });
        for (const artifact of this.artifacts.list(r.id, bootSession))
          if (!artifact.complete)
            this.artifacts.finish(artifact.id, {
              error: "Runtime exited; capture is incomplete",
            });
        for (const p of r.pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            new ControlError(
              "RUNTIME_EXITED",
              "Runtime exited; operation was not repeated",
            ),
          );
        }
        r.pending.clear();
        this.event(r, "process", {
          type: "exit",
          level: code ? "error" : "info",
          ...r.exit,
        });
        try {
          fs.unlinkSync(bootFile);
        } catch {}
      };
      child.on("error", (e) => onExit(null, null, e.message));
      child.once("exit", (code, signal) => onExit(code, signal));
      this.event(r, "process", { type: "start", pid: child.pid });
      return this.summary(r);
    } catch (error: any) {
      lock.release();
      if (reuse) reuse.keepProfileLock = false;
      if (starting) {
        starting.state = "exited";
        starting.exit = {
          error: error.message,
          time: new Date().toISOString(),
          expected: false,
        };
        this.event(starting, "process", {
          type: "start-failed",
          level: "error",
          ...starting.exit,
        });
      }
      throw error;
    }
  }
  private async message(r: Runtime, m: any) {
    if (m.type === "runtime-result") {
      const p = r.pending.get(m.id);
      if (!p) return;
      r.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error
        ? p.reject(new ControlError(m.code || "RUNTIME_ERROR", m.error))
        : p.resolve(m.result);
      return;
    }
    if (m.type === "controller-call") {
      try {
        r.process?.send({
          type: "controller-result",
          id: m.id,
          result: await (m.name === "__debug_network"
            ? this.networkAction(r, m.args)
            : m.name === "__debug_view"
              ? this.registerView(r, m.args)
              : m.name === "__debug_realtime_data"
                ? this.realtimeData(r, m.args)
                : this.dispatch(m.name, { ...m.args, runtimeId: r.id }, "human")),
        });
      } catch (e: any) {
        r.process?.send({
          type: "controller-result",
          id: m.id,
          error: e.message,
        });
      }
      return;
    }
    if (m.type !== "runtime-event") return;
    const e = m.event;
    if (e.type === "status") {
      r.status = { ...r.status, ...e.status };
      if (e.status.logicFailure) r.state = "failed";
      else if (e.status.serviceReady) r.state = "running";
      if (e.status.commandReady)
        for (const p of r.pending.values()) {
          const send = p.send;
          p.send = undefined;
          send?.();
        }
    } else if (e.type === "inspector") {
      const sessionId = r.sessionId,
        inspector = r.inspector;
      r.inspector.onEvent = (method, params) => {
        if (r.sessionId !== sessionId || r.inspector !== inspector) return;
        if (["Debugger.paused", "Debugger.resumed"].includes(method))
          this.relay.clearPaused(r.id, "logic");
        if (
          [
            "Debugger.paused",
            "Debugger.resumed",
            "Runtime.exceptionThrown",
            "Inspector.detached",
            "Inspector.reconnected",
          ].includes(method)
        )
          this.event(r, "inspector", {
            type: method,
            targetId: "logic",
            ...params,
          });
      };
      await inspector.connect(e.url, { reconnect: true });
      if (r.sessionId !== sessionId || r.inspector !== inspector) {
        inspector.close();
        return;
      }
      r.status.inspectorUrl = e.url;
      r.status.devtoolsUrl = this.relay.register(
        r.id,
        "logic",
        e.url,
        r.sessionId,
      );
      this.options.updateDevtools?.(r.id, r.status.devtoolsUrl, "logic");
      r.process?.send({ type: "boot-continue" });
      if (r.config.devtools)
        this.options.openDevtools(r.id, r.status.devtoolsUrl);
    } else if (e.type === "worker-inspector") {
      const sessionId = r.sessionId,
        targetId = `worker:${e.workerId}`;
      const client = new LogicInspector();
      r.workers.set(targetId, client);
      client.onEvent = (method, params) => {
        if (r.sessionId !== sessionId || r.workers.get(targetId) !== client)
          return;
        if (
          [
            "Debugger.paused",
            "Debugger.resumed",
            "Runtime.exceptionThrown",
            "Inspector.detached",
          ].includes(method)
        )
          this.event(r, "worker-inspector", {
            type: method,
            targetId,
            ...params,
          });
      };
      try {
        await client.connect(e.url);
        if (r.sessionId !== sessionId || r.workers.get(targetId) !== client) {
          client.close();
          return;
        }
        const url = this.relay.register(r.id, targetId, e.url, sessionId);
        r.status.viewDevtools = { ...r.status.viewDevtools, [targetId]: url };
        this.options.updateDevtools?.(r.id, url, targetId);
        r.process?.send({ type: "worker-continue", workerId: e.workerId });
      } catch (error: any) {
        client.close();
        if (r.sessionId !== sessionId || r.workers.get(targetId) !== client)
          return;
        r.workers.delete(targetId);
        this.event(r, "worker-inspector", {
          type: "worker-debugger-failed",
          targetId,
          error: error.message,
        });
      }
    } else if (e.type === "worker-destroyed") {
      const targetId = `worker:${e.workerId}`;
      r.workers.get(targetId)?.close();
      r.workers.delete(targetId);
      this.relay.unregister(r.id, targetId);
      this.releasePaused(r.id, undefined, targetId);
      if (r.status.viewDevtools) delete r.status.viewDevtools[targetId];
    } else if (e.type === "open-devtools") {
      if (e.targetId) {
        const url = r.status.viewDevtools?.[e.targetId];
        if (url) this.options.openDevtools(r.id, url, e.targetId);
      } else if (r.status.inspectorUrl)
        this.options.openDevtools(r.id, r.status.devtoolsUrl);
    } else if (e.type === "target-closed") {
      for (const record of r.requests.values())
        if (
          record.targetId === e.targetId &&
          ["pending", "headers"].includes(record.state)
        ) {
          this.recordNetwork(r, {
            ...record,
            state: "capture-error",
            captureError: "Page closed before request completion was observed",
            completionUnknown: true,
            endedAt: new Date().toISOString(),
          });
          for (const key of [
            "requestArtifactId",
            "responseArtifactId",
            "rawResponseArtifactId",
          ]) {
            if (!record[key]) continue;
            try {
              const item = this.artifacts.info(record[key]);
              if (!item.complete)
                this.artifacts.finish(item.id, {
                  error: "Page closed; body is incomplete",
                });
            } catch {}
          }
        }
      r.views.get(e.targetId)?.close();
      r.views.delete(e.targetId);
      this.relay.unregister(r.id, e.targetId);
      if (r.status.viewDevtools) delete r.status.viewDevtools[e.targetId];
      this.releasePaused(r.id, undefined, e.targetId);
      this.event(r, "target", e);
    } else if (e.type === "network") {
      if (/^\d+$/.test(e.record.id)) {
        if (
          !r.requests.has(e.record.id) &&
          Number(e.record.id) <= r.logicSequence
        )
          return;
        r.logicSequence = Math.max(r.logicSequence, Number(e.record.id));
      }
      this.recordNetwork(r, e.record);
    } else if (e.type === "human-input") {
      r.control.manual();
      this.event(r, "control", { type: "manual-takeover", ...e });
    } else this.event(r, e.source || "runtime", e);
  }
  private recordNetwork(r: Runtime, record: any) {
    const cursor = r.requests.get(record.id)?.cursor || ++r.requestSequence;
    const entry = {
      ...record,
      targetId:
        record.targetId ||
        record.context?.targetId ||
        (record.source === "logic" ? "logic" : undefined),
      cursor,
      runtimeId: r.id,
      sessionId: r.sessionId,
    };
    if (entry.requestArtifactId) delete entry.requestBody;
    if (entry.responseArtifactId) delete entry.responseBody;
    r.requests.set(record.id, entry);
    this.relay.update(r.id, entry);
    while (r.requests.size > this.limits.requestLimit)
      r.requests.delete(r.requests.keys().next().value!);
    this.event(r, "network", {
      type: record.state,
      requestId: record.id,
      context: record.context,
      url: record.url,
      targetId: record.targetId,
    });
  }
  private async registerView(r: Runtime, a: any) {
    const sessionId = r.sessionId;
    const live = () =>
      r.sessionId === sessionId && r.views.get(a.targetId) === view;
    const view = new ViewNetwork(
      r.id,
      r.sessionId,
      a.targetId,
      this.artifacts,
      r.rules,
      (record) => {
        if (live()) this.recordNetwork(r, record);
      },
      (event) => {
        if (live()) this.event(r, "view", event);
      },
      (request) => {
        if (!live())
          return Promise.reject(
            new ControlError(
              "TARGET_CLOSED",
              "Page observer is no longer current",
            ),
          );
        return this.networkAction(r, {
          action: "plan",
          targetId: a.targetId,
          request,
        });
      },
      a.targetId.startsWith("page:") && a.documentURL
        ? {
            appid: r.config.appid,
            appVersion: r.config.appVersion,
            documentURL: a.documentURL,
          }
        : undefined,
    );
    r.views.set(a.targetId, view);
    view.client.subscribe((method) => {
      if (
        r.views.get(a.targetId) === view &&
        ["Debugger.paused", "Debugger.resumed"].includes(method)
      )
        this.relay.clearPaused(r.id, a.targetId);
    });
    try {
      await view.connect(a.url);
    } catch (e) {
      if (live()) r.views.delete(a.targetId);
      view.close();
      throw e;
    }
    if (!live())
      throw new ControlError(
        "TARGET_CLOSED",
        "Page closed while its observer was starting",
      );
    const url = this.relay.register(r.id, a.targetId, a.url, r.sessionId);
    this.options.updateDevtools?.(r.id, url, a.targetId);
    r.status.viewDevtools = { ...r.status.viewDevtools, [a.targetId]: url };
    this.event(r, "target", {
      type: "attached",
      targetId: a.targetId,
      route: a.route,
      parentTargetId: a.parentTargetId,
    });
    return { attached: true, url };
  }
  private withBodies(record: any) {
    const value = { ...record };
    for (const prefix of ["request", "response"]) {
      const id = record[prefix + "ArtifactId"];
      if (!id) continue;
      let meta: any;
      try {
        meta = this.artifacts.info(id);
      } catch {
        value[prefix + "BodyUnavailable"] = "artifact metadata evicted";
        continue;
      }
      value[prefix + "BodyCapture"] = meta;
      if (meta.evicted) {
        value[prefix + "BodyUnavailable"] = "evicted";
        continue;
      }
      const bytes = this.artifacts.preview(id, this.limits.previewBytes);
      const text = /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(
        meta.mimeType || "",
      );
      value[prefix + "Body"] = text
        ? new TextDecoder(meta.charset || "utf-8").decode(bytes, {
            stream: meta.bytes > bytes.length,
          })
        : bytes.toString("base64");
      value[prefix + "BodyEncoding"] = text ? "text" : "base64";
      value[prefix + "BodyTruncated"] =
        meta.truncated || meta.bytes > bytes.length;
    }
    return value;
  }
  private protocolBody(r: Runtime, id: string, request: boolean) {
    const record = r.requests.get(id);
    if (!record)
      throw Error("Request record evicted or belongs to an old session");
    const artifactId = request
      ? record.requestArtifactId
      : record.responseArtifactId;
    if (!artifactId) {
      const body = request ? record.requestBody : record.responseBody;
      if (body === undefined) throw Error("Body is not available yet");
      if (request) return { postData: redact(body) };
      return {
        body: record.responseBodyEncoding === "base64" ? body : redact(body),
        base64Encoded: record.responseBodyEncoding === "base64",
      };
    }
    const meta = this.artifacts.get(artifactId);
    if (!meta.complete || meta.truncated || meta.error)
      throw Error(
        "Body incomplete or exceeds capture limit; inspect marked preview in Wxapp",
      );
    const bytes = this.artifacts.bytes(artifactId);
    const text = /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(
      meta.mimeType || "",
    );
    if (request) {
      if (!text) throw Error("Binary request: use the body artifact");
      return {
        postData: redact(
          new TextDecoder(meta.charset || "utf-8").decode(bytes),
        ),
      };
    }
    return {
      body: text
        ? redact(new TextDecoder(meta.charset || "utf-8").decode(bytes))
        : bytes.toString("base64"),
      base64Encoded: !text,
    };
  }
  private async protocolNetwork(
    r: Runtime,
    method: string,
    args: any,
    targetId = "logic",
  ) {
    if (method === "Network.setCacheDisabled") {
      r.rules.conditions.cacheDisabled = !!args.cacheDisabled;
      await Promise.all([...r.views.values()].map((v) => v.conditions()));
      return {};
    }
    if (
      [
        "Network.setBypassServiceWorker",
        "Network.setAttachDebugStack",
        "Network.getCookies",
      ].includes(method) &&
      targetId !== "logic"
    )
      return this.target(r, targetId).raw(method, args);
    if (method === "Network.emulateNetworkConditions") {
      Object.assign(r.rules.conditions, {
        offline: !!args.offline,
        latencyMs: args.latency || 0,
        uploadBytesPerSecond: Math.max(0, args.uploadThroughput || 0),
        downloadBytesPerSecond: Math.max(0, args.downloadThroughput || 0),
      });
      await Promise.all([...r.views.values()].map((v) => v.conditions()));
      return {};
    }
    if (method === "Network.setBlockedURLs") {
      for (const rule of r.rules.list().rules)
        if (rule.owner === "native-blocklist")
          r.rules.update(rule.id, "remove");
      for (const url of args.urls || [])
        r.rules.set(
          { enabled: true, action: "block", match: { url } },
          "native-blocklist",
        );
      return {};
    }
    throw Error("Unsupported Network command for this target: " + method);
  }
  private releasePaused(runtimeId: string, owner?: string, targetId?: string) {
    for (const [id, pause] of this.paused)
      if (
        pause.runtimeId === runtimeId &&
        (!owner || pause.owner === owner) &&
        (!targetId || pause.targetId === targetId)
      ) {
        clearTimeout(pause.timer);
        this.paused.delete(id);
        pause.resolve({ ...pause.plan, action: "continue" });
        this.event(this.runtime(runtimeId), "network-control", {
          type: "request-released",
          id,
          reason: targetId ? "target-closed" : "owner-or-runtime-disconnected",
        });
      }
  }
  private realtimeData(r: Runtime, record: RealtimeRecord) {
    return captureRealtimeData(record, content => {
      const id = this.artifacts.put({
        runtimeId: r.id, sessionId: r.sessionId, kind: "body",
        mimeType: "text/plain; charset=utf-8", representation: "realtime-data",
      }, Buffer.from(content, "utf8"));
      const saved = this.artifacts.info(id);
      if (saved.truncated || saved.evicted || saved.error)
        throw Error("Local realtime body could not be fully retained");
      return id;
    }, detail => this.event(r, "realtime", detail));
  }
  private async networkAction(r: Runtime, a: any): Promise<any> {
    if (a.action === "socket-policy") return r.rules.socketPolicy(a.url);
    if (a.action === "artifact-create")
      return {
        id: this.artifacts.create({
          runtimeId: r.id,
          sessionId: r.sessionId,
          kind: a.kind,
          mimeType: a.mimeType,
          representation: a.representation,
        }),
      };
    if (a.action.startsWith("artifact-")) {
      const item = this.artifacts.get(a.id);
      if (item.runtimeId !== r.id || item.sessionId !== r.sessionId)
        throw Error("Artifact identity mismatch");
      return a.action === "artifact-append"
        ? this.artifacts.append(a.id, new Uint8Array(a.data))
        : this.artifacts.finish(a.id, a);
    }
    if (a.action === "cancel") {
      this.cancelledRequests.set(r.sessionId + ":" + a.id, Date.now());
      while (this.cancelledRequests.size > 10000)
        this.cancelledRequests.delete(
          this.cancelledRequests.keys().next().value!,
        );
      for (const [id, pause] of this.paused)
        if (pause.runtimeId === r.id && pause.requestId === a.id) {
          clearTimeout(pause.timer);
          this.paused.delete(id);
          pause.resolve({ ...pause.plan, action: "block" });
          this.event(r, "network-control", {
            type: "cancelled",
            requestId: a.id,
          });
        }
      return {};
    }
    if (a.action !== "plan") throw Error("Unknown transport control operation");
    const plan = r.rules.evaluate(a.request);
    if (a.id && this.cancelledRequests.has(r.sessionId + ":" + a.id))
      return { ...plan, action: "block" };
    if (plan.action !== "pause") return plan;
    const id = randomUUID();
    this.event(r, "network-control", {
      type: "request-paused",
      id,
      requestId: a.id,
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.paused.delete(id);
        resolve({ ...plan, action: "continue" });
        this.event(r, "network-control", {
          type: "request-released",
          id,
          reason: "pause-timeout",
        });
      }, 60000);
      this.paused.set(id, {
        id,
        runtimeId: r.id,
        targetId: a.targetId,
        owner: plan.owner,
        requestId: a.id,
        plan,
        resolve,
        timer,
      });
    });
  }
  private invoke(r: Runtime, name: string, args: any, signal?: AbortSignal) {
    if (
      !r.process?.connected ||
      !["starting", "running", "failed"].includes(r.state)
    )
      return Promise.reject(
        new ControlError(
          "RUNTIME_EXITED",
          "Runtime is not running; restart it explicitly",
        ),
      );
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const aborted = () => {
        r.process?.connected && r.process.send({ type: "runtime-cancel", id });
      };
      signal?.addEventListener("abort", aborted, { once: true });
      const done = (fn: Function, value: any) => {
        signal?.removeEventListener("abort", aborted);
        fn(value);
      };
      const timer = setTimeout(
        () => {
          r.pending.delete(id);
          aborted();
          done(
            reject,
            new ControlError(
              "OPERATION_TIMEOUT",
              "Runtime command timed out and may have executed; inspect state before another action",
            ),
          );
        },
        name === "runner_wait" ? 65000 : 35000,
      );
      const send = () => {
        if (signal?.aborted) {
          r.pending.delete(id);
          clearTimeout(timer);
          done(
            reject,
            new ControlError(
              "CANCELLED",
              "Command cancelled before dispatch; no input sent",
            ),
          );
          return;
        }
        r.process!.send({ type: "runtime-call", id, name, args });
      };
      r.pending.set(id, {
        timer,
        resolve: (v: any) => done(resolve, v),
        reject: (e: any) => done(reject, e),
        send: r.status.commandReady ? undefined : send,
      });
      if (r.status.commandReady) send();
      if (signal?.aborted) aborted();
    });
  }
  async stop(r: Runtime) {
    if (!r.process || !["starting", "running", "failed"].includes(r.state))
      return this.summary(r);
    r.status.stopping = true;
    // Disconnect inspectors before terminating a worker that may wait for debugger detach.
    r.inspector.close();
    for (const worker of r.workers.values()) worker.close();
    for (const view of r.views.values()) view.close();
    const child = r.process;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.connected
        ? child.send({ type: "runtime-stop" })
        : child.kill("SIGTERM");
    });
    return this.summary(r);
  }
  async dispatch(
    name: string,
    raw: any = {},
    clientId = "legacy",
    signal?: AbortSignal,
  ): Promise<any> {
    const result = projectRows(
      name,
      raw,
      await this.dispatchInternal(name, raw, clientId, signal),
    );
    if (name === "runner_packages") return result;
    const runtimeId = result?.runtimeId || raw.runtimeId || this.defaultId;
    const sessionId =
      result?.sessionId ||
      raw.sessionId ||
      this.runtimes.get(runtimeId)?.sessionId;
    const identify = (row: any) =>
      row && typeof row === "object" ? { runtimeId, sessionId, ...row } : row;
    return Array.isArray(result) ? result.map(identify) : identify(result);
  }
  private async dispatchInternal(
    name: string,
    raw: any = {},
    clientId = "legacy",
    signal?: AbortSignal,
  ): Promise<any> {
    const a: any = parseTool(name, raw);
    a._clientId = clientId;
    if (name === "runner_packages")
      return callPackages(
        a,
        { repoRoot: path.resolve(this.options.root, "..") },
        signal,
      );
    if (name === "runner_runtime") {
      if (a.action === "list")
        return {
          runtimes: [...this.runtimes.values()].map((r) => this.summary(r)),
          defaultRuntimeId: this.defaultId,
        };
      if (a.action === "start") {
        const argv = [
          "--package",
          a.packageDir,
          ...(a.appid ? ["--appid", a.appid] : []),
          ...(a.baselibDir ? ["--baselib", a.baselibDir] : []),
          ...(a.configFile ? ["--config", a.configFile] : []),
          ...(a.contactsFile ? ["--contacts", a.contactsFile] : []),
          ...(a.pagePath !== undefined ? ["--page-path", a.pagePath] : []),
          ...(a.loaderAdapter ? ["--loader-adapter", a.loaderAdapter] : []),
          ...(a.appVersion !== undefined
            ? ["--app-version", String(a.appVersion)]
            : []),
        ];
        const next = readConfig(argv);
        return this.start({
          ...next,
          analysis: analysisConfig(next.analysis, a),
          profile: a.profile,
          devtools: a.devtools,
        });
      }
      const r = this.runtime(a.runtimeId);
      if (
        a.action !== "closeSession" &&
        a.sessionId &&
        a.sessionId !== r.sessionId
      )
        throw new ControlError(
          "SESSION_CHANGED",
          "Session changed; obtain fresh state before changing the runtime",
        );
      if (clientId === "human") r.control.manual();
      return r.control.run(clientId, async () => {
        if (a.action === "stop") return this.stop(r);
        if (a.action === "restart") {
          const analysis = analysisConfig(r.config.analysis, a);
          const profile =
            a.profile ||
            (analysis.enabled && !r.config.analysis?.enabled
              ? undefined
              : r.config.profile);
          return this.start(
            {
              ...r.config,
              analysis,
              profile,
              loaderAdapter: a.loaderAdapter || r.config.loaderAdapter,
              ...(a.contactsFile ? { contactsFile: a.contactsFile } : {}),
              ...(a.pagePath !== undefined
                ? { launchTarget: resolveLaunchTarget(r.config.app, a.pagePath) }
                : {}),
              ...(a.appVersion !== undefined
                ? { appVersion: a.appVersion, appVersionSource: "explicit" }
                : {}),
            },
            r,
          );
        }
        if (a.action === "switch") {
          const next = readConfig([
            "--package",
            a.packageDir,
            "--config",
            a.configFile || r.config.configFile,
            ...(a.contactsFile ? ["--contacts", a.contactsFile] : []),
            ...(a.pagePath !== undefined ? ["--page-path", a.pagePath] : []),
            ...(a.appid ? ["--appid", a.appid] : []),
            ...(a.appVersion !== undefined
              ? ["--app-version", String(a.appVersion)]
              : []),
            "--baselib",
            a.baselibDir || r.config.baselibDir,
            "--loader-adapter",
            a.loaderAdapter || r.config.loaderAdapter || "legacy",
          ]);
          return this.start(
            {
              ...next,
              analysis: analysisConfig(next.analysis, a),
              userDataDir: r.config.persistentRoot,
              profile: a.profile || r.config.profile,
            },
            r,
          );
        }
        const sessionId = a.sessionId || r.sessionId;
        if (
          sessionId === r.sessionId &&
          ["starting", "running", "failed"].includes(r.state)
        )
          throw Error("Stop the runtime before closing its diagnostic session");
        const archived = this.archives.get(sessionId);
        if (sessionId !== r.sessionId && archived?.id !== r.id)
          throw Error("Session does not belong to this runtime");
        (archived || r).requests.clear();
        this.archives.delete(sessionId);
        this.artifacts.closeSession(sessionId);
        return { sessionId, status: "closed" };
      });
    }
    if (name === "runner_events" || name === "runner_trace") {
      const runtime = this.runtime(a.runtimeId);
      const sessionId = a.sessionId || runtime.sessionId;
      if (
        sessionId !== runtime.sessionId &&
        this.archives.get(sessionId)?.id !== runtime.id
      )
        throw new ControlError(
          "SESSION_CHANGED",
          "Diagnostic session does not belong to the selected runtime",
        );
      return this.events.page({ ...a, runtimeId: runtime.id, sessionId });
    }
    let r = this.runtime(a.runtimeId);
    if (a.sessionId && a.sessionId !== r.sessionId) {
      const archive = this.archives.get(a.sessionId);
      if (
        archive?.id === r.id &&
        (name === "runner_network" ||
          name === "runner_artifact" ||
          (name === "runner_profile" && ["get", "list"].includes(a.action)))
      )
        r = archive;
      else
        throw new ControlError(
          "SESSION_CHANGED",
          "Session changed; obtain a fresh cursor and snapshot",
        );
    }
    if (
      name === "runner_execution" &&
      ["export", "getExport", "cancelExport"].includes(a.action)
    ) {
      if (a.action === "getExport")
        return this.executionExports.get(a.jobId, r.id);
      if (a.action === "cancelExport")
        return this.executionExports.cancel(a.jobId, r.id, clientId);
      const sessionId = r.sessionId;
      return this.executionExports.start({
        runtimeId: r.id,
        sessionId,
        clientId,
        runId: a.runId,
        revealSensitive: a.revealSensitive,
        artifacts: this.artifacts,
        read: (args) =>
          this.dispatch(
            "runner_execution",
            { ...args, runtimeId: r.id, sessionId },
            clientId,
          ),
      });
    }
    if (clientId === "human" && !isRead(name, a)) r.control.manual();
    if (
      [
        "runner_hook",
        "runner_source",
        "runner_network",
        "runner_crypto_watch",
        "runner_slice",
        "runner_oracle",
        "runner_execution",
      ].includes(name)
    ) {
      const analysis = new AnalysisTools(
        async (tool, args) => {
          if (tool === "runner_network") return this.rawNetwork(r, args);
          // Fixed read/list expressions must remain readable while a business eval
          // is paused or another client owns the write lease.
          if (
            tool === "runner_evaluate" &&
            [
              "runner_hook",
              "runner_crypto_watch",
              "runner_slice",
              "runner_oracle",
              "runner_execution",
            ].includes(name) &&
            [
              "read",
              "list",
              "status",
              "diff",
              "explain",
              "oracleList",
              "cryptoCandidates",
              "dependencies",
              "summary",
            ].includes(a.action)
          )
            return this.target(r, "logic").command("evaluate", args);
          return this.dispatch(
            tool,
            { runtimeId: r.id, ...args },
            clientId,
            signal,
          );
        },
        (data, identity) =>
          this.artifacts.put(
            {
              ...identity,
              kind: "execution-report",
              mimeType: "application/json",
              representation:
                name === "runner_source"
                  ? "source-code"
                  : a.revealSensitive
                    ? "explicit-sensitive-export"
                    : "redacted",
            },
            Buffer.from(JSON.stringify(data)),
          ),
      );
      return analysis.dispatch(name, a);
    }
    if (name === "runner_autopsy") {
      if (a.action === "list") return { jobs: this.autopsies.list(r.id) };
      if (a.action === "get")
        return this.autopsies.get(a.jobId, r.id, a.revealSensitive);
      if (a.action === "cancel")
        return this.autopsies.cancel(a.jobId, r.id, clientId);
      if (a.action !== "preflight") r.control.check(clientId);
      const epoch = r.control.state().epoch,
        sessionId = r.sessionId;
      const jobClient = clientId === "human" ? "autopsy-human" : clientId;
      const options: AutopsyOptions = {
        runtimeId: r.id,
        sessionId,
        clientId,
        requestStatus: (id) => {
          if (r.sessionId !== sessionId) return undefined;
          const item = r.requests.get(id);
          return (
            item && {
              state: item.state,
              status: item.status,
              error: item.error,
              durationMs: item.durationMs,
            }
          );
        },
        // A task explicitly waiting for human input observes that input; it
        // never submits business actions, so human takeover need not cancel it.
        check: () => {
          if (r.sessionId !== sessionId)
            throw new ControlError(
              "SESSION_CHANGED",
              "Analysis instance restarted",
            );
          if (
            a.action !== "preflight" &&
            a.trigger &&
            r.control.state().epoch !== epoch
          )
            throw new ControlError(
              "CONTROL_CHANGED",
              "Human took control; inspect state before another action",
            );
          if (a.action !== "preflight") r.control.check(jobClient);
        },
        call: (tool, args, abort) =>
          this.dispatch(
            tool,
            { ...args, runtimeId: r.id, sessionId },
            jobClient,
            abort,
          ),
        artifact: (report, sensitive) =>
          this.artifacts.put(
            {
              runtimeId: r.id,
              sessionId,
              kind: "execution-report",
              mimeType: "application/json",
              representation: sensitive
                ? "explicit-sensitive-export"
                : "redacted",
            },
            Buffer.from(JSON.stringify(report)),
          ),
      };
      return a.action === "preflight"
        ? autopsyPreflight(a, options)
        : this.autopsies.start(a, options);
    }
    if (name === "runner_suite") {
      if (a.action === "contracts") {
        const result = this.contractCatalog.query(r.config.baselibDir,a);
        const observations=r.status.loader?.nativeContracts?.entries||[],gaps=r.status.loader?.nativeBoundary?.entries||[];
        if(result.collection==="contracts") result.entries=result.entries.map((entry:any)=>({...entry,observed:{
          calls:observations.filter((o:any)=>o.contractId===entry.id),gaps:gaps.filter((o:any)=>o.contractId===entry.id),
          policy:"Exact contract identity only; absence of observation is not a successful call"}}));
        if(a.exportReport) {
          const ledger=this.contractCatalog.read(r.config.baselibDir).ledger!;
          const id=this.artifacts.put({runtimeId:r.id,sessionId:r.sessionId,kind:"native-contract-ledger",mimeType:"application/json",representation:"metadata-only"},Buffer.from(JSON.stringify(ledger)));
          return {...result,artifact:this.artifacts.info(id)};
        }
        return result;
      }
      if (a.action === "contractRun") return this.contractJobs.start(a.scenarioId,r.id,r.sessionId,clientId);
      if (a.jobId?.startsWith("contract:")) return a.action === "cancel" ? this.contractJobs.cancel(a.jobId,r.id,clientId) : this.contractJobs.get(a.jobId,r.id);
      if (a.action === "list") return { jobs: [...this.suites.list(r.id),...this.contractJobs.list(r.id)] };
      if (a.action === "get") return this.suites.get(a.jobId, r.id);
      if (a.action === "cancel")
        return this.suites.cancel(a.jobId, r.id, clientId);
      const key = r.sessionId + ":" + (a.sourceDir || "");
      let catalog = this.catalogs.get(key);
      if (!catalog) {
        catalog = buildCatalog({ ...r.config, sourceDir: a.sourceDir });
        this.catalogs.set(key, catalog);
      }
      if (a.action === "catalog") {
        const pages = catalog.pages.filter(
          (p) =>
            (!a.route || p.route === a.route) &&
            (!a.group || p.group === a.group),
        );
        return {
          ...catalog,
          pages: pages.slice(a.offset, a.offset + a.limit),
          matched: pages.length,
          hasMore: a.offset + a.limit < pages.length,
        };
      }
      r.control.check(clientId);
      const epoch = r.control.state().epoch,
        sessionId = r.sessionId;
      return this.suites.start({
        runtimeId: r.id,
        sessionId,
        clientId,
        routes: a.routes || [],
        mode: a.mode,
        steps: a.steps,
        timeoutMs: a.timeoutMs,
        availableRoutes: catalog.pages.map((p) => p.route),
        check: () => {
          if (r.sessionId !== sessionId)
            throw new ControlError(
              "SESSION_CHANGED",
              "Suite stopped after session change",
            );
          r.control.check(clientId);
          if (r.control.state().epoch !== epoch)
            throw new ControlError(
              "CONTROL_CHANGED",
              "Human takeover stopped the suite; no operations replayed",
            );
        },
        call: (name, args, signal) =>
          this.dispatch(
            name,
            { ...args, runtimeId: r.id, sessionId },
            clientId === "human" ? "human-suite" : clientId,
            signal,
          ),
        emit: (e) => this.event(r, "suite", e),
        capture: (image) =>
          this.artifacts.info(
            this.artifacts.put(
              {
                runtimeId: r.id,
                sessionId,
                kind: "screenshot",
                mimeType: "image/png",
              },
              Buffer.from(image, "base64"),
            ),
          ),
      });
    }
    if (name === "runner_control") {
      if (a.action === "state") return r.control.state();
      return a.action === "release"
        ? r.control.release(clientId)
        : r.control.acquire(clientId, a.ttlMs);
    }
    if (
      name === "runner_screenshot" &&
      (a.target !== "shell" || a.fullPage || a.container || a.targetId)
    ) {
      if (a.target === "shell")
        throw new ControlError(
          "UNSUPPORTED_CAPABILITY",
          "Full screenshots require a page target",
        );
      const targetId = a.targetId || "page:" + r.status.current?.id;
      const client = this.target(r, targetId);
      if (targetId === "logic" || targetId.startsWith("worker:"))
        throw new ControlError(
          "UNSUPPORTED_CAPABILITY",
          "This target has no DOM screenshot",
        );
      if (a.container)
        return r.control.run(clientId, async () => ({
          ...(await captureContainer(client, a.container)),
          runtimeId: r.id,
          sessionId: r.sessionId,
          targetId,
        }));
      const metrics = await client.raw("Page.getLayoutMetrics");
      const rect = metrics.cssContentSize || metrics.contentSize;
      if (a.fullPage && rect.width * rect.height > 64000000)
        throw Error(
          "Screenshot exceeds 64 million pixels; select a smaller scroll container",
        );
      const result = await client.raw(
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: !!a.fullPage,
          ...(a.fullPage ? { clip: { ...rect, scale: 1 } } : {}),
        },
        30000,
      );
      return {
        image: result.data,
        mimeType: "image/png",
        runtimeId: r.id,
        sessionId: r.sessionId,
        targetId,
        fullPage: !!a.fullPage,
      };
    }
    if (name === "runner_profile") {
      if (a.action === "list")
        return { jobs: this.profiles.list(r.id, r.sessionId) };
      if (a.action === "get") return this.profiles.inspect(a.jobId, r.id);
      return r.control.run(clientId, async () =>
        a.action === "stop"
          ? this.profiles.stop(a.jobId, r.id)
          : this.profiles.start(
              r.id,
              r.sessionId,
              a.targetId || "logic",
              a.kind,
              this.target(r, a.targetId),
            ),
      );
    }
    if (["runner_debugger", "runner_evaluate"].includes(name)) {
      const targetId = a.targetId || "logic";
      const client = this.target(r, targetId);
      if (a.action === "open") {
        const url =
          targetId === "logic"
            ? r.status.devtoolsUrl
            : r.status.viewDevtools?.[targetId];
        if (!url || !client.isConnected)
          throw new ControlError(
            "TARGET_DISCONNECTED",
            "Cannot open a disconnected target",
          );
        this.options.openDevtools(r.id, url, targetId);
        return {
          runtimeId: r.id,
          sessionId: r.sessionId,
          targetId,
          status: "opened",
        };
      }
      const call = async () => {
        const nativePause = !client.paused && this.relay.paused(r.id, targetId);
        let result: any;
        if (name === "runner_evaluate" && a.callFrameId && nativePause)
          result = await this.relay.command(
            r.id,
            targetId,
            "Debugger.evaluateOnCallFrame",
            {
              callFrameId: a.callFrameId,
              expression: a.expression,
              returnByValue: a.returnByValue !== false,
              objectGroup: "wxapp-native-debug",
            },
          );
        else if (
          ["resume", "stepOver", "stepInto", "stepOut"].includes(a.action) &&
          nativePause
        )
          result = await this.relay.command(
            r.id,
            targetId,
            "Debugger." + a.action,
          );
        else if (
          a.action === "properties" &&
          this.relay.ownsObject(r.id, targetId, a.objectId)
        )
          result = await this.relay.command(
            r.id,
            targetId,
            "Runtime.getProperties",
            {
              objectId: a.objectId,
              ownProperties: a.ownProperties,
              generatePreview: true,
            },
          );
        else if (
          a.action === "removeBreakpoint" &&
          a.breakpointId.startsWith("native:")
        ) {
          const bp = this.relay
            .breakpoints(r.id, targetId)
            .find((b) => b.breakpointId === a.breakpointId);
          if (!bp || !this.options.removeNativeBreakpoint)
            throw new ControlError(
              "TARGET_DISCONNECTED",
              "Native breakpoint no longer has a live Sources editor",
            );
          result = await this.options.removeNativeBreakpoint(
            r.id,
            targetId,
            bp,
          );
        } else
          result =
            a.action === "capabilities"
              ? this.capabilities(targetId)
              : await client.command(
                  name === "runner_evaluate" ? "evaluate" : a.action,
                  {
                    ...a,
                    viewTarget:
                      targetId !== "logic" && !targetId.startsWith("worker:"),
                  },
                );
        if (a.action === "state" && nativePause) {
          result.paused = nativePause;
          result.pauseOwner = "native-devtools";
        }
        if (["state", "breakpoints"].includes(a.action))
          result.breakpoints = [
            ...(result.breakpoints || []),
            ...this.relay.breakpoints(r.id, targetId).map((bp) => ({
              ...bp,
              editable: !!this.options.removeNativeBreakpoint,
            })),
          ];
        return { ...result, runtimeId: r.id, sessionId: r.sessionId, targetId };
      };
      if (name === "runner_evaluate" && a.callFrameId) {
        r.control.check(clientId);
        return call();
      }
      if (
        name === "runner_debugger" &&
        !isRead(name, a) &&
        !independentControl(name, a)
      ) {
        // Breakpoint edits must be possible while an evaluation is paused.
        r.control.check(clientId);
        let lane = this.debuggerControls.get(r.id);
        if (!lane) {
          lane = new ControlQueue();
          this.debuggerControls.set(r.id, lane);
        }
        const epoch = r.control.state().epoch,
          sessionId = r.sessionId;
        return lane.run(clientId, async () => {
          r.control.check(clientId);
          if (epoch !== r.control.state().epoch || sessionId !== r.sessionId)
            throw new ControlError(
              "CONTROL_CHANGED",
              "Debugger control changed; refresh target state",
            );
          return call();
        });
      }
      return isRead(name, a) || independentControl(name, a)
        ? call()
        : r.control.run(clientId, call);
    }
    if (name === "runner_status")
      return {
        ...this.summary(r),
        control: r.control.state(),
        limits: this.limits,
      };
    if (name === "runner_logs")
      return this.events.page({
        ...a,
        runtimeId: r.id,
        sessionId: r.sessionId,
      });
    if (name === "runner_wait") {
      if (a.kind === "operation" && a.action === "start") {
        // Validate the nested condition with the existing wait contract before touching the runtime.
        const condition = parseTool("runner_wait", {
          ...a.result,
          action: "start",
          waitId: a.waitId,
          timeoutMs: a.timeoutMs,
          stableMs: a.stableMs,
          target: a.target,
          targetId: a.targetId,
          runtimeId: r.id,
          sessionId: r.sessionId,
        });
        let after = 0,
          found = false;
        for (;;) {
          const page = this.events.page({
            runtimeId: r.id,
            sessionId: r.sessionId,
            operationId: a.operationId,
            after,
            limit: 200,
          });
          found ||= page.entries.length > 0;
          after = page.nextCursor;
          if (!page.hasMore) break;
        }
        if (!found)
          throw new ControlError(
            "OPERATION_NOT_FOUND",
            "Operation is unknown or its events were evicted; read current state",
          );
        const result = await this.dispatch(
          "runner_wait",
          condition,
          clientId,
          signal,
        );
        const completed = result.status === "matched";
        if (completed)
          this.event(r, "operation", {
            type: "result-condition-matched",
            context: {
              operationId: a.operationId,
              rootOperationId: a.operationId,
            },
            condition: a.result,
            association: "caller-specified-result-condition",
          });
        return {
          ...result,
          runtimeId: r.id,
          sessionId: r.sessionId,
          operationId: a.operationId,
          businessCompleted: completed,
          completionBasis: "caller-specified-result-condition",
        };
      }
      const scope = r.id + ":" + r.sessionId;
      if (
        a.action === "cancel" &&
        this.waits.list(clientId, scope).some((w) => w.waitId === a.waitId)
      )
        return this.waits.cancel(a.waitId, clientId, scope);
      if (a.action === "list") {
        const child = ["starting", "running", "failed"].includes(r.state)
          ? await this.invoke(r, name, { ...a, _clientId: clientId }, signal)
          : [];
        return [...this.waits.list(clientId, scope), ...child];
      }
      if (a.action === "start" && ["network", "log"].includes(a.kind)) {
        const sessionId = r.sessionId;
        const after =
          a.after ??
          (a.kind === "network"
            ? r.requestSequence
            : this.events.page({ limit: 1 }).latestId);
        return this.waits.run(
          { ...a, scope },
          async () => {
            if (r.sessionId !== sessionId)
              throw new ControlError(
                "SESSION_CHANGED",
                "Runtime restarted during wait",
              );
            if (a.kind === "log") {
              let cursor = after;
              for (;;) {
                const page = this.events.page({
                  runtimeId: r.id,
                  sessionId,
                  after: cursor,
                  limit: 200,
                  source: a.source,
                  level: a.level,
                });
                if (page.gap || page.cursorResetRequired)
                  throw Error(
                    "Event cursor was evicted or belongs to another session",
                  );
                const row = page.entries.find(
                  (e) => !a.text || JSON.stringify(e).includes(a.text),
                );
                if (row) return { matched: true, value: row };
                if (!page.hasMore) break;
                cursor = page.nextCursor;
              }
              return { matched: false };
            }
            const oldest =
              r.requests.values().next().value?.cursor || r.requestSequence + 1;
            if (after < oldest - 1 || after > r.requestSequence)
              throw Error(
                "Network cursor evicted or belongs to another session",
              );
            const match = [...r.requests.values()].find(
              (row) =>
                row.cursor > after &&
                (!a.requestId || row.id === a.requestId) &&
                (!a.urlIncludes || row.url.includes(a.urlIncludes)) &&
                (!a.method || row.method === a.method.toUpperCase()) &&
                (!a.statusCode || row.status === a.statusCode) &&
                row.state === a.networkState,
            );
            return { matched: !!match, value: match && redact(match) };
          },
          signal,
        );
      }
    }
    if (name === "runner_artifact") {
      if (a.action === "session")
        return exportNetworkSession(
          this.artifacts,
          [...r.requests.values()].map((row) => this.withBodies(row)),
          { runtimeId: r.id, sessionId: r.sessionId },
          a.destination,
          a.revealSensitive,
        );
      if (a.action === "list")
        return { artifacts: this.artifacts.list(r.id, r.sessionId) };
      if (a.id) {
        const item = this.artifacts.get(a.id);
        if (item.runtimeId !== r.id)
          throw Error("Artifact belongs to another runtime");
        return a.action === "read"
          ? this.artifacts.read(a.id, a.offset, a.length, a.revealSensitive)
          : this.artifacts.export(a.id, a.destination, a.revealSensitive);
      }
      const entries = [...r.requests.values()]
        .map((row) => this.withBodies(row))
        .map((row) => ({
          startedDateTime: row.startedAt,
          time: row.durationMs ?? 0,
          request: {
            method: row.method,
            url: row.url,
            httpVersion: row.protocol || "unknown",
            headers: Object.entries(row.requestHeaders || {}).map(
              ([name, value]) => ({ name, value }),
            ),
            queryString: [...new URL(row.url).searchParams].map(
              ([name, value]) => ({ name, value }),
            ),
            cookies: [],
            headersSize: -1,
            bodySize: row.hops?.at(-1)?.requestBytes ?? -1,
            ...(row.requestBody !== undefined
              ? {
                  postData: {
                    mimeType:
                      row.requestHeaders?.["content-type"] ||
                      "application/octet-stream",
                    text: row.requestBody,
                    _encoding: row.requestBodyEncoding,
                    _truncated: row.requestBodyTruncated,
                  },
                }
              : {}),
          },
          response: {
            status: row.status || 0,
            statusText: "",
            httpVersion: row.protocol || "unknown",
            headers: Object.entries(row.responseHeaders || {}).map(
              ([name, value]) => ({ name, value }),
            ),
            cookies: [],
            content: {
              size: row.decodedBytes ?? -1,
              mimeType:
                row.responseHeaders?.["content-type"] ||
                "application/octet-stream",
              text: row.responseBody,
              ...(row.responseBodyEncoding === "base64"
                ? { encoding: "base64" }
                : {}),
              _truncated: row.responseBodyTruncated,
            },
            redirectURL: row.responseHeaders?.location || "",
            headersSize: -1,
            bodySize: row.encodedBytes ?? -1,
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: -1,
            connect: -1,
            ssl: -1,
            send: -1,
            wait: -1,
            receive: -1,
          },
          _wxapp: {
            id: row.id,
            source: row.source,
            targetId: row.targetId,
            context: row.context,
            error: row.error,
            responseArtifactId: row.responseArtifactId,
            observedHeadersMs: row.headersMs,
            rules: row.rules,
          },
        }));
      const har = {
        log: {
          version: "1.2",
          creator: { name: "WxappRunner", version: "0.2.0" },
          entries,
        },
      };
      const id = this.artifacts.put(
        {
          runtimeId: r.id,
          sessionId: r.sessionId,
          kind: "har",
          mimeType: "application/json",
        },
        Buffer.from(JSON.stringify(a.revealSensitive ? har : redact(har))),
      );
      return this.artifacts.info(id);
    }
    if (name === "runner_replay") {
      const original = r.requests.get(a.id);
      if (!original) throw Error("Original request was evicted or not found");
      const url = a.url || original.url;
      if (!["http:", "https:"].includes(new URL(url).protocol))
        throw Error("Replay supports only HTTP(S)");
      const method = (a.method || original.method).toUpperCase();
      const headers = replayHeaders(
        original.requestHeaders || {},
        original.url,
        url,
        a.headers,
      );
      let bodyPath: string | undefined;
      if (!["GET", "HEAD"].includes(method) && a.body === undefined) {
        if (original.requestArtifactId) {
          const body = this.artifacts.get(original.requestArtifactId);
          if (!body.complete || body.truncated || body.evicted || body.error)
            throw Error(
              "Original body unavailable or incomplete; provide a replacement body",
            );
          if (body.bytes) bodyPath = body.file;
        } else if (
          original.requestBodyTruncated ||
          original.requestBodyUnavailable
        )
          throw Error("Original body unavailable; provide a replacement body");
      }
      if (["GET", "HEAD"].includes(method) && a.body !== undefined)
        throw Error("GET/HEAD replay cannot include a body");
      if (
        a.bodyEncoding === "base64" &&
        a.body !== undefined &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          a.body,
        )
      )
        throw Error("Invalid base64 body");
      return r.control.run(clientId, () =>
        this.invoke(
          r,
          "__replay",
          {
            originalId: original.id,
            url,
            method,
            headers,
            bodyPath,
            body: a.body,
            bodyEncoding: a.bodyEncoding,
          },
          signal,
        ),
      );
    }
    if (name === "runner_network_rules") {
      const action = async () => {
        if (a.action === "list") return r.rules.list();
        if (a.action === "set") return r.rules.set(a.rule, clientId);
        if (["remove", "enable", "disable"].includes(a.action))
          return r.rules.update(a.id, a.action);
        if (a.action === "conditions") {
          Object.assign(r.rules.conditions, a.conditions);
          await Promise.all([...r.views.values()].map((v) => v.conditions()));
          return r.rules.list();
        }
        if (a.action === "paused")
          return {
            requests: [...this.paused.values()]
              .filter((p) => p.runtimeId === r.id)
              .map(({ resolve, timer, ...p }) => p),
          };
        const pause = this.paused.get(a.id);
        if (!pause || pause.runtimeId !== r.id)
          throw Error("Paused request is stale or belongs to another runtime");
        if (clientId !== "human" && pause.owner !== clientId)
          throw new ControlError(
            "CONTROL_OCCUPIED",
            "Paused request belongs to another client; its owner or a human must resolve it",
          );
        const d = a.decision || { action: "continue" };
        if (!["continue", "modify", "block", "mock"].includes(d.action))
          throw Error("Unknown paused-request decision");
        const request =
          d.action === "modify"
            ? changeRequest(pause.plan.request, d.change || {})
            : pause.plan.request;
        if (d.action === "mock")
          d.response = ruleSchema.parse({
            match: { url: "*" },
            action: "mock",
            response: d.response,
          }).response;
        clearTimeout(pause.timer);
        this.paused.delete(a.id);
        pause.resolve(
          r.rules.enforceExperiment({
            ...pause.plan,
            request,
            action: d.action === "modify" ? "continue" : d.action,
            response: d.response,
          }),
        );
        this.event(r, "network-control", {
          type: "request-released",
          id: a.id,
          decision: d.action,
        });
        return { id: a.id, status: "released" };
      };
      const result = await (["list", "paused", "resolve"].includes(a.action)
        ? action()
        : r.control.run(clientId, action));
      return a.revealSensitive ? result : redact(result);
    }
    const call = async () => {
      // Native DevTools is in the controller process; an unfocused child can
      // accept insertText without emitting focus/keyboard events to baselib.
      // Scope Chromium focus emulation to one explicit input operation and
      // use the independent CDP connection, keeping human DevTools attached.
      const inputTarget =
        name === "runner_input"
          ? this.target(r, a.targetId || "page:" + r.status.current?.id)
          : undefined;
      if (inputTarget)
        await inputTarget.raw("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
      let result: any;
      try {
        result = await this.invoke(
          r,
          name,
          { ...a, _clientId: clientId },
          signal,
        );
      } finally {
        if (inputTarget)
          try {
            await inputTarget.raw("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            });
          } catch (error: any) {
            this.event(r, "bridge", {
              type: "focus-emulation-cleanup-error",
              message: error.message,
            });
          }
      }
      return result && typeof result === "object" && !Array.isArray(result)
        ? { ...result, runtimeId: r.id, sessionId: r.sessionId }
        : result;
    };
    return isRead(name, a) || independentControl(name, a)
      ? call()
      : r.control.run(clientId, call);
  }
  private rawNetwork(r: Runtime, a: any) {
    let result: any;
    if (a.id) {
      result = r.requests.get(a.id);
      if (!result) throw Error("Request not found or evicted");
      result = this.withBodies(result);
    } else {
      const rows = [...r.requests.values()].filter(
        (e) => a.after === undefined || e.cursor > a.after,
      );
      const entries = (
        a.after === undefined ? rows.slice(-a.limit) : rows.slice(0, a.limit)
      ).map(({ requestBody, responseBody, ...rest }) => rest);
      const oldestCursor =
        r.requests.values().next().value?.cursor || r.requestSequence + 1;
      result =
        a.after === undefined
          ? entries
          : {
              entries,
              nextCursor: entries.at(-1)?.cursor ?? a.after,
              latestCursor: r.requestSequence,
              oldestCursor,
              gap: a.after < oldestCursor - 1,
              cursorResetRequired: a.after > r.requestSequence,
              hasMore: rows.length > entries.length,
            };
    }
    return a.revealSensitive ? result : redact(result);
  }
  private disconnectClient(clientId: string) {
    this.clients.delete(clientId);
    this.suites.disconnect(clientId);
    this.executionExports.disconnect(clientId);
    this.autopsies.disconnect(clientId);
    for (const r of this.runtimes.values()) {
      r.control.disconnect(clientId);
      this.releasePaused(r.id, clientId);
      for (const rule of r.rules.list().rules)
        if (rule.owner === clientId && rule.action === "pause")
          r.rules.update(rule.id, "disable");
      this.event(r, "control", { type: "client-disconnected", clientId });
    }
    for (const w of this.waits.list(clientId))
      this.waits.cancel(w.waitId, clientId);
  }
  async listen(file?: string) {
    this.heartbeat = setInterval(() => {
      for (const [id, seen] of this.clients)
        if (Date.now() - seen > 20000) this.disconnectClient(id);
    }, 1000);
    this.heartbeat.unref();
    this.server = http.createServer(async (req, res) => {
      res.setHeader("X-Wxapp-Analysis", String(analysisProtocolVersion));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      const mapPrefix = "/source-map/" + this.token + "/";
      if (
        req.method === "GET" &&
        req.url?.startsWith(mapPrefix) &&
        (!req.headers.origin || req.headers.origin === "devtools://devtools")
      ) {
        const map = this.sourceMaps.get(req.url.slice(mapPrefix.length));
        if (!map) {
          res.writeHead(404).end("{}");
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", "devtools://devtools");
        res.end(map.content);
        return;
      }
      if (
        req.headers.origin ||
        req.headers.authorization !== `Bearer ${this.token}`
      ) {
        res.writeHead(403).end("{}");
        return;
      }
      if (
        req.method !== "POST" ||
        !["/call", "/client"].includes(req.url || "")
      ) {
        res.writeHead(404).end("{}");
        return;
      }
      const cancel = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) cancel.abort();
      });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw Error("Request too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const clientId =
          typeof body.clientId === "string" ? body.clientId : "legacy";
        if (req.url === "/client") {
          if (body.action === "disconnect") this.disconnectClient(clientId);
          else this.clients.set(clientId, Date.now());
          res.end(JSON.stringify({ connected: body.action !== "disconnect" }));
          return;
        }
        if (clientId !== "legacy") this.clients.set(clientId, Date.now());
        const result = await this.dispatch(
          body.name,
          body.arguments,
          typeof body.clientId === "string" ? body.clientId : "legacy",
          cancel.signal,
        );
        res.end(JSON.stringify({ result }));
      } catch (e: any) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({ error: e.message, code: e.code || "DEBUG_ERROR" }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(this.server.address() as any).port}`;
    this.endpoint = endpoint;
    this.relay.attach(this.server, endpoint, this.token);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(
      temp,
      JSON.stringify({
        endpoint,
        token: this.token,
        pid: process.pid,
        runtimeId: this.defaultId,
        appid: this.defaultId ? this.runtime().config.appid : undefined,
        version: 2,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, file);
    this.files.add(file);
    console.log("MCP connection file:", file);
  }
  async close() {
    this.closing = true;
    this.contractJobs.close();
    clearInterval(this.heartbeat);
    this.waits.close();
    this.suites.close();
    this.executionExports.close();
    this.autopsies.close();
    await Promise.all([...this.runtimes.values()].map((r) => this.stop(r)));
    this.server?.close();
    this.artifacts.close();
    this.relay.close();
    for (const file of this.files) {
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).token === this.token)
          fs.unlinkSync(file);
      } catch {}
    }
  }
}

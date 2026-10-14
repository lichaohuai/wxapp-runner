import { randomUUID } from "node:crypto";
import { LogicInspector } from "../mcp/inspector";
import { ArtifactStore } from "./artifacts";
import { ControlError } from "./control";
type Job = {
  id: string;
  runtimeId: string;
  sessionId: string;
  targetId: string;
  kind: string;
  state: string;
  startedAt: string;
  endedAt?: string;
  artifactId?: string;
  progress?: any;
  error?: string;
  client: LogicInspector;
  unsubscribe?: () => void;
};
/** Jobs outlive HTTP calls. Heap chunks and Chromium IO streams are written directly to artifacts. */
export class ProfileJobs {
  private jobs = new Map<string, Job>();
  constructor(
    private artifacts: ArtifactStore,
    private emit: (job: any) => void,
  ) {}
  private public(job: Job) {
    const { client, unsubscribe, ...result } = job;
    return result;
  }
  list(runtimeId: string, sessionId?: string) {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.runtimeId === runtimeId &&
          (!sessionId || sessionId === j.sessionId),
      )
      .map((j) => this.public(j));
  }
  get(id: string, runtimeId: string) {
    const j = this.jobs.get(id);
    if (!j || j.runtimeId !== runtimeId)
      throw new ControlError(
        "JOB_NOT_FOUND",
        "Analysis job does not belong to this runtime",
      );
    return j;
  }
  inspect(id: string, runtimeId: string) {
    return this.public(this.get(id, runtimeId));
  }
  start(
    runtimeId: string,
    sessionId: string,
    targetId: string,
    kind: string,
    client: LogicInspector,
  ) {
    if (!client.isConnected)
      throw new ControlError(
        "TARGET_DISCONNECTED",
        "Analysis target is disconnected",
      );
    if (kind === "trace" && (targetId === "logic" || targetId.startsWith("worker:")))
      throw new ControlError(
        "UNSUPPORTED_CAPABILITY",
        "Chromium performance trace requires a view target; logic supports CPU profiling",
      );
    if (
      [...this.jobs.values()].some(
        (j) =>
          j.runtimeId === runtimeId &&
          j.targetId === targetId &&
          ["starting", "running", "stopping"].includes(j.state),
      )
    )
      throw new ControlError(
        "JOB_CONFLICT",
        "An analysis job is already active on this target",
      );
    const job: Job = {
      id: randomUUID(),
      runtimeId,
      sessionId,
      targetId,
      kind,
      client,
      state: "starting",
      startedAt: new Date().toISOString(),
    };
    if (this.jobs.size >= 1000) {
      const old = [...this.jobs.values()].find((j) =>
        ["complete", "failed"].includes(j.state),
      );
      if (old) this.jobs.delete(old.id);
    }
    this.jobs.set(job.id, job);
    job.unsubscribe = client.subscribe((method, p) => {
      if (method === "Inspector.detached")
        this.fail(job, Error("Target disconnected; analysis is incomplete"));
      if (
        kind === "heap" &&
        method === "HeapProfiler.addHeapSnapshotChunk" &&
        job.artifactId &&
        job.state === "running"
      )
        this.artifacts.append(job.artifactId, Buffer.from(p.chunk));
      if (
        kind === "heap" &&
        method === "HeapProfiler.reportHeapSnapshotProgress"
      ) {
        job.progress = p;
        this.emit(this.public(job));
      }
      if (kind === "trace" && method === "Tracing.tracingComplete")
        void this.traceComplete(job, p);
    });
    void this.begin(job).catch((e) => this.fail(job, e));
    return this.public(job);
  }
  private async begin(j: Job) {
    if (j.kind === "cpu") {
      await j.client.raw("Profiler.enable");
      await j.client.raw("Profiler.start");
    } else if (j.kind === "trace")
      await j.client.raw("Tracing.start", {
        transferMode: "ReturnAsStream",
        streamFormat: "json",
        traceConfig: {
          recordMode: "recordContinuously",
          includedCategories: [
            "devtools.timeline",
            "v8.execute",
            "disabled-by-default-devtools.timeline",
            "blink.user_timing",
          ],
        },
      });
    else {
      await j.client.raw("HeapProfiler.enable");
      if (j.state === "failed") return;
      if (j.kind === "allocations")
        await j.client.raw("HeapProfiler.startSampling", {
          samplingInterval: 32768,
        });
      else {
        j.artifactId = this.create(j, "heapsnapshot");
        j.state = "running";
        this.emit(this.public(j));
        await j.client.raw(
          "HeapProfiler.takeHeapSnapshot",
          { reportProgress: true, captureNumericValue: true },
          300000,
        );
        this.finish(j);
        return;
      }
    }
    if (j.state === "failed") return;
    j.state = "running";
    this.emit(this.public(j));
  }
  stop(id: string, runtimeId: string) {
    const j = this.get(id, runtimeId);
    if (j.state === "starting")
      throw new ControlError(
        "JOB_STARTING",
        "Analysis is starting; query its state before stopping",
      );
    if (["complete", "failed", "stopping"].includes(j.state))
      return this.public(j);
    if (j.kind === "heap")
      throw new ControlError(
        "UNSUPPORTED_CAPABILITY",
        "V8 heap snapshots cannot be cancelled safely; query the job until completion",
      );
    j.state = "stopping";
    void (async () => {
      if (j.kind === "trace") {
        await j.client.raw("Tracing.end");
        return;
      }
      const result = await j.client.raw(
        j.kind === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling",
        {},
        60000,
      );
      j.artifactId = this.create(
        j,
        j.kind === "cpu" ? "cpuprofile" : "heapprofile",
      );
      this.artifacts.append(
        j.artifactId,
        Buffer.from(JSON.stringify(result.profile)),
      );
      this.finish(j);
    })().catch((e) => this.fail(j, e));
    return this.public(j);
  }
  private create(j: Job, kind: string) {
    return this.artifacts.create({
      runtimeId: j.runtimeId,
      sessionId: j.sessionId,
      kind,
      mimeType: "application/json",
    });
  }
  private async traceComplete(j: Job, p: any) {
    if (j.state === "failed") return;
    if (!p.stream) {
      this.fail(j, Error("Chromium did not return a trace stream"));
      return;
    }
    j.artifactId = this.create(j, "trace");
    try {
      for (;;) {
        const chunk = await j.client.raw(
          "IO.read",
          { handle: p.stream, size: 262144 },
          60000,
        );
        const meta = this.artifacts.append(
          j.artifactId,
          Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"),
        );
        j.progress = { bytes: meta.observedBytes };
        if (chunk.eof) break;
      }
      if (p.dataLossOccurred) throw Error("Chromium reported trace data loss");
      this.finish(j);
    } catch (e) {
      this.fail(j, e);
    } finally {
      await j.client.raw("IO.close", { handle: p.stream }).catch(() => {});
    }
  }
  private finish(j: Job) {
    if (j.state === "failed") return;
    if (!j.artifactId) {
      this.fail(j, Error("Analysis did not produce an artifact"));
      return;
    }
    const meta = this.artifacts.finish(j.artifactId);
    if (meta.truncated || meta.evicted) {
      this.fail(
        j,
        Error(
          "Analysis exceeded the artifact cache budget; result is incomplete",
        ),
      );
      return;
    }
    j.state = "complete";
    j.endedAt = new Date().toISOString();
    j.progress = { bytes: meta.bytes };
    j.unsubscribe?.();
    this.emit(this.public(j));
  }
  private fail(j: Job, error: any) {
    if (["failed", "complete"].includes(j.state)) return;
    j.state = "failed";
    j.error = error.message || String(error);
    j.endedAt = new Date().toISOString();
    if (j.artifactId) this.artifacts.finish(j.artifactId, { error: j.error });
    j.unsubscribe?.();
    this.emit(this.public(j));
  }
}

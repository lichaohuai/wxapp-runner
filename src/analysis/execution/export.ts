import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { ArtifactStore } from "../../controller/artifacts";

/** Export a stopped run in bounded pages. Eviction during export is explicit. */
export class ExecutionExports {
  private jobs = new Map<string, any>();
  start(options: { runtimeId: string; sessionId: string; clientId: string; runId: string;
    revealSensitive: boolean; read: (args: any) => Promise<any>; artifacts: ArtifactStore }) {
    if ([...this.jobs.values()].some(j => j.runtimeId === options.runtimeId && j.state === "running")) throw Error("EXECUTION_EXPORT_BUSY");
    const job = { id: randomUUID(), runtimeId: options.runtimeId, sessionId: options.sessionId,
      clientId: options.clientId, runId: options.runId, state: "running", records: 0, pages: 0,
      bytes: 0, gap: false, artifactId: "", cancelled: false, startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 100) { const old = [...this.jobs].find(([, j]) => j.state !== "running"); if (!old) break; this.jobs.delete(old[0]); }
    void (async () => {
      const check = () => { if (job.cancelled) throw Error("EXPORT_CANCELLED"); if (Date.now() - Date.parse(job.startedAt) > 300000) throw Error("EXPORT_TIMEOUT"); };
      try {
        const status = await options.read({action:"status"});
        const run = status.runs?.find((r: any) => r.id === options.runId);
        if (!run) throw Error("RUN_NOT_FOUND");
        if (run.state === "recording") throw Error("STOP_RUN_BEFORE_EXPORT");
        check();
        job.artifactId = options.artifacts.create({runtimeId:options.runtimeId, sessionId:options.sessionId,
          kind:"execution-records", mimeType:"application/x-ndjson", representation:options.revealSensitive ? "explicit-sensitive-export" : "redacted"});
        const append = (value: any) => {
          const info = options.artifacts.append(job.artifactId, Buffer.from(JSON.stringify(value) + "\n"));
          job.bytes = info.bytes;
          if (info.truncated || info.evicted) throw Error("ARTIFACT_BUDGET_EXCEEDED");
        };
        append({type:"metadata", version:1, runtimeId:options.runtimeId, sessionId:options.sessionId, run, cache:status.cache});
        let after = 0;
        for (;;) {
          check();
          let page = await options.read({action:"read", runId:options.runId, after, limit:20, revealSensitive:options.revealSensitive});
          if (page.outputLimited && page.artifactId) {
            const artifact = options.artifacts.get(page.artifactId);
            if (!artifact.complete || artifact.evicted || artifact.truncated) throw Error("EXPORT_PAGE_UNAVAILABLE");
            page = JSON.parse(fs.readFileSync(artifact.file, "utf8"));
          }
          check();
          job.gap ||= !!page.gap;
          append({type:"page", ...page});
          job.records += page.entries?.length || 0;
          job.pages++;
          if (!page.hasMore) break;
          if (!(page.nextCursor > after)) throw Error("EXPORT_CURSOR_DID_NOT_ADVANCE");
          after = page.nextCursor;
        }
        job.state = job.gap ? "incomplete" : "complete";
      } catch (e: any) { job.state = job.cancelled ? "cancelled" : "failed"; Object.assign(job, {error:e.message}); }
      finally {
        if (job.artifactId) options.artifacts.finish(job.artifactId, {error:job.state === "complete" ? undefined : job.state});
        Object.assign(job, {endedAt:new Date().toISOString()});
      }
    })();
    return this.get(job.id, options.runtimeId);
  }
  get(id: string, runtimeId: string) { const job=this.jobs.get(id); if (!job || job.runtimeId !== runtimeId) throw Error("EXPORT_NOT_FOUND"); return {...job}; }
  cancel(id: string, runtimeId: string, clientId: string) { const job=this.get(id,runtimeId); if (clientId !== job.clientId && clientId !== "human") throw Error("EXPORT_NOT_OWNED"); this.jobs.get(id).cancelled=true; return this.get(id,runtimeId); }
  disconnect(clientId: string) { for (const j of this.jobs.values()) if(j.clientId === clientId && j.state === "running") j.cancelled=true; }
  close() { for (const j of this.jobs.values()) j.cancelled=true; }
}

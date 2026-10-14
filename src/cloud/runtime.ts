import { randomUUID } from "node:crypto";
import {
  debugContext,
  traceContext,
  emitDebug,
  copyDebug,
} from "../debug/context";
import { redact } from "../mcp/redact";
/** Runs the original cloud SDK; it never substitutes local database results. */
export class CloudRuntime {
  private jobs = new Map<string, any>();
  constructor(
    private sdk: any,
    private configured: boolean,
  ) {}
  query(args: any) {
    if (args.action === "status")
      return {
        configured: this.configured,
        sdkAvailable: !!this.sdk,
        provider: "original-baselib-cloud-sdk via wxbot operatewxdata",
        capabilities: [
          "callFunction",
          "database",
          "getTempFileURL",
          "downloadFile",
          "uploadFile",
          "deleteFile",
        ].filter((k) => typeof this.sdk?.[k] === "function"),
        environment:
          "Provided by app wx.cloud.init or explicit job env; no environment inferred from account login",
        remoteAuthorization: "separate from hardware permission",
        jobs: [...this.jobs.values()].map(({ result, ...j }) => j),
      };
    if (args.action === "list")
      return { jobs: [...this.jobs.values()].map(({ result, ...j }) => j) };
    if (args.action === "get") {
      const job = this.jobs.get(args.jobId);
      if (!job) throw Error("Cloud job not found in this runtime session");
      return args.revealSensitive
        ? copyDebug(job).value
        : redact(copyDebug(job).value);
    }
    if (args.action !== "start") throw Error("Unknown cloud action");
    if (!this.configured) throw Error("wxbot is not configured");
    if (!this.sdk) throw Error("Real cloud SDK unavailable");
    const writes = [
      "function",
      "databaseAdd",
      "databaseUpdate",
      "databaseRemove",
      "deleteFile",
    ];
    if (writes.includes(args.operation) && args.confirm !== true)
      throw Error("This remote operation requires confirm:true");
    const cfg = args.env ? { env: args.env } : undefined;
    let run: () => Promise<any>;
    if (args.operation === "function") {
      if (!args.name) throw Error("function name required");
      run = () =>
        this.sdk.callFunction({
          name: args.name,
          data: args.data || {},
          config: cfg,
        });
    } else if (args.operation.startsWith("database")) {
      if (!args.collection) throw Error("collection required");
      const collection = this.sdk.database(cfg).collection(args.collection);
      if (args.operation === "databaseQuery")
        run = () =>
          collection
            .where(args.where || {})
            .limit(args.limit || 20)
            .get();
      else if (args.operation === "databaseAdd")
        run = () => collection.add({ data: args.data });
      else {
        if (!args.documentId)
          throw Error("Explicit documentId required; no bulk mutations");
        run = () =>
          args.operation === "databaseUpdate"
            ? collection.doc(args.documentId).update({ data: args.data })
            : collection.doc(args.documentId).remove();
      }
    } else if (args.operation === "fileUrl")
      run = () =>
        this.sdk.getTempFileURL({ fileList: args.fileList, config: cfg });
    else if (args.operation === "downloadFile")
      run = () => this.sdk.downloadFile({ fileID: args.fileId, config: cfg });
    else if (args.operation === "deleteFile")
      run = () => this.sdk.deleteFile({ fileList: args.fileList, config: cfg });
    else throw Error("Unsupported cloud operation");
    const context = traceContext({
      kind: "cloud",
      handler: "runner_cloud." + args.operation,
    });
    const job: any = {
      id: randomUUID(),
      operation: args.operation,
      operationId: context.operationId,
      rootOperationId: context.rootOperationId,
      state: "pending",
      startedAt: new Date().toISOString(),
      remoteWritesPossible: writes.includes(args.operation),
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 100) {
      const oldest = [...this.jobs].find(([, j]) => j.state !== "pending");
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
    }
    debugContext.run(context, () => {
      emitDebug("cloud-job-start", {
        jobId: job.id,
        operation: args.operation,
      });
      void Promise.resolve()
        .then(run)
        .then(
          (result) => {
            job.state = "complete";
            job.result = copyDebug(result).value;
            job.sdkCompleted = true;
          },
          (error) => {
            job.state = "failed";
            job.error = copyDebug(error).value;
          },
        )
        .finally(() => {
          job.endedAt = new Date().toISOString();
          emitDebug("cloud-job-result", {
            jobId: job.id,
            state: job.state,
            error: job.error,
          });
        });
    });
    return {
      jobId: job.id,
      operationId: job.operationId,
      status: "submitted",
      businessCompleted: false,
    };
  }
}

import { randomUUID } from "node:crypto";

export class ControlError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/** Queue dispatch, not business completion. Debugger recovery has its own lane. */
export class ControlQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private lease?: { id: string; clientId: string; expiresAt: number };
  state() {
    if (this.lease && this.lease.expiresAt <= Date.now())
      this.lease = undefined;
    return { epoch: this.epoch, lease: this.lease ? { ...this.lease } : null };
  }
  acquire(clientId: string, ttlMs = 60000) {
    this.check(clientId);
    this.lease = {
      id: this.lease?.id || randomUUID(),
      clientId,
      expiresAt: Date.now() + ttlMs,
    };
    return this.state();
  }
  release(clientId: string) {
    this.check(clientId);
    this.lease = undefined;
    return this.state();
  }
  manual() {
    this.epoch++;
    this.lease = undefined;
    return this.state();
  }
  disconnect(clientId: string) {
    if (this.lease?.clientId === clientId) {
      this.epoch++;
      this.lease = undefined;
    }
  }
  check(clientId: string) {
    const { lease } = this.state();
    if (lease && lease.clientId !== clientId)
      throw new ControlError(
        "CONTROL_OCCUPIED",
        "Another client holds control of this runtime",
      );
  }
  run<T>(clientId: string, task: () => Promise<T>) {
    this.check(clientId);
    const epoch = this.epoch;
    const result = this.tail.then(() => {
      this.check(clientId);
      if (epoch !== this.epoch)
        throw new ControlError(
          "CONTROL_CHANGED",
          "Manual control changed; read fresh state before issuing another operation",
        );
      return task();
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

export function isRead(name: string, a: any) {
  return (
    [
      "runner_status",
      "runner_snapshot",
      "runner_logs",
      "runner_events",
      "runner_trace",
      "runner_wait",
    ].includes(name) ||
    (["runner_crypto_watch", "runner_slice", "runner_oracle"].includes(name) &&
      ["read", "list", "status", "diff"].includes(a.action)) ||
    (name === "runner_execution" &&
      [
        "status",
        "read",
        "explain",
        "diff",
        "oracleList",
        "cryptoCandidates",
        "dependencies", "export", "getExport", "cancelExport",
        "summary",
      ].includes(a.action)) ||
    (name === "runner_autopsy" &&
      ["list", "get", "cancel", "preflight"].includes(a.action)) ||
    (name === "runner_hook" && ["list", "read"].includes(a.action)) ||
    (name === "runner_source" && !a.allowModuleLoad) ||
    (name === "runner_screenshot" && !a.container) ||
    (name === "runner_runtime" && a.action === "list") ||
    (name === "runner_control" && a.action === "state") ||
    (name === "runner_profile" && ["list", "get"].includes(a.action)) ||
    (name === "runner_native" &&
      ["list", "get", "capabilities"].includes(a.action)) ||
    (name === "runner_cloud" && ["status", "list", "get"].includes(a.action)) ||
    (name === "runner_device" &&
      (["get", "capabilities"].includes(a.action) ||
        (a.action === "location" && a.location === undefined))) ||
    (name === "runner_suite" &&
      ["catalog", "list", "get", "contracts"].includes(a.action)) ||
    (name === "runner_network_rules" &&
      ["list", "paused"].includes(a.action)) ||
    (name === "runner_artifact" && ["list", "read"].includes(a.action)) ||
    (name === "runner_network" &&
      (!a.action || ["list", "get", "diff"].includes(a.action))) ||
    (name === "runner_state" &&
      a.action !== "setData" &&
      !(a.action === "location" && a.location !== undefined)) ||
    (name === "runner_storage" && ["list", "get"].includes(a.action)) ||
    (name === "runner_dialog" && a.action === "list") ||
    (name === "runner_dom" && a.action === "inspect") ||
    (name === "runner_debugger" &&
      [
        "state",
        "source",
        "breakpoints",
        "search",
        "properties",
        "capabilities",
      ].includes(a.action))
  );
}
export function independentControl(name: string, a: any) {
  return (
    name === "runner_wait" ||
    (name === "runner_autopsy" && a.action === "cancel") ||
    name === "runner_control" ||
    (name === "runner_suite" && a.action === "cancel") ||
    (name === "runner_debugger" &&
      ["pause", "resume", "stepOver", "stepInto", "stepOut"].includes(a.action))
  );
}

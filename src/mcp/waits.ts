import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
export class WaitRegistry {
  private active = new Map<
    string,
    {
      controller: AbortController;
      startedAt: string;
      kind: string;
      owner?: string;
      scope?: string;
    }
  >();
  list(owner?: string, scope?: string) {
    return [...this.active]
      .filter(
        ([, v]) =>
          (!owner || v.owner === owner) && (!scope || v.scope === scope),
      )
      .map(([waitId, v]) => ({
        waitId,
        startedAt: v.startedAt,
        kind: v.kind,
      }));
  }
  cancel(waitId: string, owner?: string, scope?: string) {
    const entry = this.active.get(waitId);
    if (
      !entry ||
      (owner && entry.owner !== owner) ||
      (scope && entry.scope !== scope)
    )
      throw Error(
        "Wait not active or owned by another client or runtime session",
      );
    entry.controller.abort();
    return { waitId, status: "cancelled", businessOperationChanged: false };
  }
  close() {
    for (const v of this.active.values()) v.controller.abort();
  }
  async run(
    args: {
      waitId?: string;
      timeoutMs: number;
      kind: string;
      _clientId?: string;
      scope?: string;
    },
    probe: () => Promise<any>,
    external?: AbortSignal,
  ) {
    const waitId = args.waitId || randomUUID();
    if (this.active.has(waitId)) throw Error("waitId already active");
    if (this.active.size >= 16) throw Error("Too many active waits");
    const controller = new AbortController(),
      start = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, args.timeoutMs);
    const cancel = () => controller.abort();
    external?.addEventListener("abort", cancel, { once: true });
    if (external?.aborted) cancel();
    this.active.set(waitId, {
      controller,
      startedAt: new Date().toISOString(),
      kind: args.kind,
      owner: args._clientId,
      scope: args.scope,
    });
    const signal = controller.signal;
    try {
      while (!signal.aborted) {
        const result = await new Promise<any>((resolve, reject) => {
          const onAbort = () => reject(Error("wait-aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(probe)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
        });
        if (result?.matched)
          return {
            waitId,
            status: "matched",
            elapsedMs: performance.now() - start,
            result: result.value,
          };
        await delay(75, undefined, { signal });
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", cancel);
      this.active.delete(waitId);
    }
    return {
      waitId,
      status: timedOut ? "timeout" : "cancelled",
      elapsedMs: performance.now() - start,
      businessOperationChanged: false,
    };
  }
}

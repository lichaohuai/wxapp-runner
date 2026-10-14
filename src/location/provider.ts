import fs from "node:fs";
import { spawn } from "node:child_process";

export type SystemAuthorization =
  | "authorized"
  | "notDetermined"
  | "denied"
  | "restricted"
  | "disabled"
  | "unknown";
export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  speed?: number;
  altitude?: number;
  verticalAccuracy?: number;
}
export interface LocationProvider {
  readonly available: boolean;
  readonly name: string;
  status(): Promise<SystemAuthorization>;
  locate(
    options: { highAccuracy: boolean; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<LocationFix>;
  close(): void;
}
// Runner diagnostic codes are intentionally distinct from unverified WeChat numeric errCodes.
export function locationError(code: string, message: string) {
  return Object.assign(new Error(message), { runnerCode: code });
}

export class MacLocationProvider implements LocationProvider {
  readonly name = "CoreLocation";
  readonly available: boolean;
  private pending = new Set<() => void>();
  private closed = false;
  constructor(private executable: string) {
    this.available = process.platform === "darwin" && fs.existsSync(executable);
  }
  private invoke(
    args: any,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(locationError("RUNTIME_CLOSED", "runtime closed"));
    if (!this.available)
      return Promise.reject(
        locationError(
          "LOCATION_UNSUPPORTED",
          "native location provider unavailable on this platform; build the macOS helper first",
        ),
      );
    if (signal?.aborted)
      return Promise.reject(
        locationError("LOCATION_CANCELLED", "location cancelled"),
      );
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        done = false;
      const finish = (error?: Error, result?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(cancel);
        if (child.exitCode === null) child.kill();
        error ? reject(error) : resolve(result);
      };
      const cancel = () =>
        finish(
          locationError(
            "LOCATION_CANCELLED",
            "location cancelled: page or runtime closed",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            locationError("LOCATION_TIMEOUT", "native location helper timeout"),
          ),
        timeout,
      );
      this.pending.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      child.on("error", () =>
        finish(
          locationError(
            "LOCATION_PROVIDER_FAILED",
            "cannot start native location helper",
          ),
        ),
      );
      child.stdin.on("error", () =>
        finish(
          locationError(
            "LOCATION_PROVIDER_FAILED",
            "native location helper input closed",
          ),
        ),
      );
      child.stdout.on("data", (b) => {
        output += b.toString("utf8");
        if (Buffer.byteLength(output) > 16384)
          finish(
            locationError(
              "LOCATION_PROVIDER_FAILED",
              "invalid native location response size",
            ),
          );
      });
      // Native OS diagnostics are not business logs and may contain personal data.
      child.stderr.resume();
      child.on("close", (code) => {
        if (done) return;
        try {
          const r = JSON.parse(output);
          if (!r.ok)
            throw locationError(
              r.code || "LOCATION_PROVIDER_FAILED",
              r.message || "native location failed",
            );
          if (code !== 0)
            throw locationError(
              "LOCATION_PROVIDER_FAILED",
              "native location helper exited abnormally",
            );
          finish(undefined, r);
        } catch (e: any) {
          finish(
            e.runnerCode
              ? e
              : locationError(
                  "LOCATION_PROVIDER_FAILED",
                  "native location helper returned invalid JSON",
                ),
          );
        }
      });
      child.stdin.end(JSON.stringify(args));
    });
  }
  async status(): Promise<SystemAuthorization> {
    return (await this.invoke({ action: "status" }, 5000)).authorization;
  }
  async locate(
    options: { highAccuracy: boolean; timeoutMs: number },
    signal: AbortSignal,
  ) {
    return this.invoke(
      { action: "location", ...options },
      options.timeoutMs + 5000,
      signal,
    );
  }
  close() {
    this.closed = true;
    for (const cancel of this.pending) cancel();
  }
}

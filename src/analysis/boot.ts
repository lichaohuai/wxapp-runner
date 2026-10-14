import { executionRuntime } from "./execution/runtime";
import { types } from "node:util";
import { installAnalysisWebCrypto } from "./webcrypto";
import { debugContext, emitDebug } from "../debug/context";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHash,
  createHmac,
  createCipheriv,
  randomUUID,
} from "node:crypto";
import { bootAnalysisSchema } from "./boot-schema";
import { bootAnalysisRuntime } from "./boot-runtime";
import { targetPlan } from "./targets";
import { vmFunction } from "./serialize";
import {
  analysisIntrinsicNames,
  reserveAnalysisIntrinsics,
} from "./intrinsics";
export function analysisConfig(base: any = {}, override: any = {}) {
  const input = { ...base, ...override.analysis };
  if (override.bootScript !== undefined) input.bootScript = override.bootScript;
  if (override.defeatAntiHook !== undefined)
    input.defeatAntiHook = override.defeatAntiHook;
  if (override.bootScript !== undefined || override.defeatAntiHook === true)
    input.enabled = true;
  if (input.execution?.enabled) input.enabled = true;
  const c = bootAnalysisSchema.parse(input);
  if (c.bootScript)
    new vm.Script(c.bootScript, { filename: "wxapp-analysis-boot.js" });
  for (const s of c.taps) targetPlan(s.target);
  return c;
}
export function prepareBootAnalysis(context: vm.Context, raw: any) {
  const cfg = analysisConfig(raw);
  if (!cfg.enabled || !cfg.defeatAntiHook) return;
  return vm.runInContext(
    `${vmFunction(reserveAnalysisIntrinsics)}(${JSON.stringify(analysisIntrinsicNames)})`,
    context,
    { filename: "wxapp-analysis-reservation.js", timeout: 3000 },
  ) as { finish(): any };
}
export function installBootAnalysis(
  context: vm.Context,
  raw: any,
  preparation?: any,
) {
  const cfg = analysisConfig(raw);
  if (!cfg.enabled) return;
  if (cfg.webCrypto) installAnalysisWebCrypto(context);
  const als = new AsyncLocalStorage<any>();
  Object.defineProperty(context, "__runnerAnalysisContext", {
    value: Object.freeze({
      realmId: randomUUID(),
      get: () => ({ ...debugContext.getStore(), ...als.getStore() }),
      isProxy: types.isProxy,
      now: Date.now,
      hash: (algo: string, input: string) => {
        if (
          !["md5", "sha1", "sha256", "sha384", "sha512", "sm3"].includes(
            algo,
          ) ||
          input.length > 8192
        )
          return null;
        try {
          return createHash(algo).update(input, "utf8").digest("hex");
        } catch {
          return null;
        }
      },
      // Same algorithm set + utf8-or-bytes(string=>utf8) key/message encoding as
      // crypto-evidence.ts. Bounded like hash(); used by cryptoCandidates' opt-in
      // HMAC cross-match. Non-string (opaque) keys still need explicit taps.
      hmac: (algo: string, key: string, input: string) => {
        if (
          !["md5", "sha1", "sha256", "sha384", "sha512", "sm3"].includes(algo) ||
          typeof key !== "string" ||
          typeof input !== "string" ||
          key.length > 8192 ||
          input.length > 8192
        )
          return null;
        try {
          return createHmac(algo, Buffer.from(key, "utf8"))
            .update(input, "utf8")
            .digest("hex");
        } catch {
          return null;
        }
      },
      // AES-ECB(Pkcs7) with a UTF-8 string key (16/24/32 bytes) over UTF-8
      // plaintext, hex output. Lets cryptoCandidates reverse simple ECB
      // signatures (e.g. an X-Sign that is AES-ECB(hex) of a short string)
      // without a tap. Non-string/opaque keys, CBC/IV and other encodings still
      // need explicit taps.
      aesEcb: (keyStr: string, input: string) => {
        if (typeof keyStr !== "string" || typeof input !== "string") return null;
        const key = Buffer.from(keyStr, "utf8");
        if (![16, 24, 32].includes(key.length) || input.length > 8192)
          return null;
        try {
          const c = createCipheriv("aes-" + key.length * 8 + "-ecb", key, null);
          return Buffer.concat([
            c.update(Buffer.from(input, "utf8")),
            c.final(),
          ]).toString("hex");
        } catch {
          return null;
        }
      },
      emit: (event: any) => emitDebug("analysis-probe", event),
      run: (value: any, fn: () => any) =>
        als.run(value, () =>
          debugContext.run(
            {
              ...debugContext.getStore(),
              analysisRunId: value.runId,
              analysisCallId: value.callId,
              executionRunId: value.executionRunId,
              executionEventId: value.executionEventId,
            },
            fn,
          ),
        ),
    }),
  });
  const params = {
    ...cfg,
    phase: "boot",
    preparation,
    intrinsicNames: analysisIntrinsicNames,
    bootScript: undefined,
    taps: cfg.taps.map((s) => ({ ...s, plan: targetPlan(s.target) })),
  };
  vm.runInContext(
    `${vmFunction(bootAnalysisRuntime)}(${JSON.stringify(params)})`,
    context,
    { filename: "wxapp-analysis-runtime.js", timeout: 3000 },
  );
  if (cfg.execution?.enabled)
    vm.runInContext(
      `${vmFunction(executionRuntime)}(${JSON.stringify(cfg.execution)})`,
      context,
      { filename: "wxapp-execution-runtime.js", timeout: 3000 },
    );
  if (cfg.bootScript)
    try {
      vm.runInContext(cfg.bootScript, context, {
        filename: "wxapp-analysis-boot.js",
        timeout: 3000,
      });
    } catch (e) {
      vm.runInContext(
        'globalThis.__wxappBootAnalysisV1.command({action:"stop"})',
        context,
        { timeout: 1000 },
      );
      throw e;
    }
  return {
    phase: "boot",
    scriptSha256: cfg.bootScript
      ? createHash("sha256").update(cfg.bootScript).digest("hex")
      : undefined,
    defeatAntiHook: cfg.defeatAntiHook,
    randomPinned: cfg.randomSeed !== undefined,
  };
}

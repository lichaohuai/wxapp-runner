import { emitDebug } from "../debug/context";
export type Options = {
  success?: (r: any) => void;
  fail?: (r: any) => void;
  complete?: (r: any) => void;
  [k: string]: any;
};
export function success(name: string, o: Options = {}, r: any = {}) {
  const result = { errMsg: name + ":ok", ...r };
  try {
    emitDebug("callback", { api: name, callback: "success" });
    o.success?.(result);
  } finally {
    emitDebug("callback", { api: name, callback: "complete" });
    o.complete?.(result);
  }
  return result;
}
export function failure(name: string, o: Options = {}, error: any) {
  const r = {
    errMsg: name + ":fail " + (error?.message || String(error)),
    ...(typeof error?.runnerCode === "string"
      ? { runnerCode: error.runnerCode }
      : {}),
  };
  try {
    emitDebug("callback", { api: name, callback: "fail", error: r });
    o.fail?.(r);
  } finally {
    emitDebug("callback", { api: name, callback: "complete" });
    o.complete?.(r);
  }
  return r;
}
export function asyncApi(
  name: string,
  o: Options = {},
  run: () => Promise<any>,
) {
  const promise = run().then(
    (r) => success(name, o, r),
    (e) => {
      const r = failure(name, o, e);
      if (!o.fail && !o.complete && !o.success) throw r;
      return undefined;
    },
  );
  return promise;
}

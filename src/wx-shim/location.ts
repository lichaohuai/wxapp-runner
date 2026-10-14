import { asyncApi, type Options } from "./common";
import { emitDebug } from "../debug/context";

export function locationApis(rpc: (name: string, args: any) => Promise<any>) {
  function invoke(name: string, options: Options = {}) {
    return asyncApi(name, options, async () => {
      const { success, fail, complete, ...args } = options;
      const started = Date.now();
      emitDebug("native-api", {
        api: name,
        phase: "start",
        args,
        stack: new Error().stack,
      });
      try {
        const result = await rpc(name, args);
        emitDebug("native-api", {
          api: name,
          phase: "success",
          result,
          durationMs: Date.now() - started,
        });
        return result;
      } catch (error: any) {
        emitDebug("native-api", {
          api: name,
          phase: "fail",
          error: { message: error.message, runnerCode: error.runnerCode },
          durationMs: Date.now() - started,
        });
        throw error;
      }
    });
  }
  function getLocation(options: Options = {}) {
    return invoke("getLocation", options);
  }
  function getSetting(options: Options = {}) {
    return invoke("getSetting", options);
  }
  function authorize(options: Options) {
    return invoke("authorize", options);
  }
  function openSetting(options: Options = {}) {
    return invoke("openSetting", options);
  }
  return { getLocation, getSetting, authorize, openSetting };
}

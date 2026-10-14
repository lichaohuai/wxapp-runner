import { WxbotClient } from "../wxbot";
import { asyncApi, failure, type Options } from "./common";
export function accountApi(config: any, log: Function, originalCloud?: any) {
  const client = new WxbotClient(config, log);
  async function userInfo(o: Options) {
    const result = await client.call("getuserinfo", {
      lang: o.lang || "zh_CN",
    });
    if (typeof result.data === "string") {
      return {
        userInfo: JSON.parse(result.data),
        rawData: result.data,
        signature: result.signature,
        encryptedData: result.encryptedData,
        iv: result.iv,
        ...(result.cloud_id ? { cloudID: result.cloud_id } : {}),
      };
    }
    return result;
  }
  function login(o: Options = {}) {
    return asyncApi("login", o, async () => ({
      code: (await client.call("jslogin")).code,
    }));
  }
  function getUserInfo(o: Options = {}) {
    return asyncApi("getUserInfo", o, () => userInfo(o));
  }
  function getUserProfile(o: Options = {}) {
    return asyncApi("getUserProfile", o, () => userInfo(o));
  }
  function getPhoneNumber(o: Options = {}) {
    return asyncApi("getPhoneNumber", o, () => client.call("getphonenumber"));
  }
  function requestPayment(o: Options = {}) {
    log("UNIMPLEMENTED: wx.requestPayment");
    queueMicrotask(() =>
      failure(
        "requestPayment",
        o,
        Error("payment is unavailable in WxappRunner"),
      ),
    );
  }
  function callFunction(o: Options) {
    return asyncApi("cloud.callFunction", o, async () => {
      // The provided OpenAPI omits env. The configured macmini explicitly
      // rejected a documented request with "need ... env, function_name".
      if (typeof o.config?.env !== "string" || !o.config.env)
        throw Error(
          "Direct cloudfunction requires explicit config.env; original cloud SDK is preferred",
        );
      return client.call("cloudfunction", {
        function_name: o.name,
        data: JSON.stringify(o.data ?? {}),
        env: o.config.env,
      });
    });
  }
  return {
    login,
    getUserInfo,
    getUserProfile,
    getPhoneNumber,
    requestPayment,
    cloud: originalCloud || {
      init(options: any = {}) {
        throw Error("Original base-library cloud SDK is unavailable");
      },
      callFunction,
    },
  };
}

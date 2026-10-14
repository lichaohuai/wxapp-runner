import { gatewayURL } from "./gateway-url";
const endpoints = new Set([
  "jslogin",
  "refreshsession",
  "getuserinfo",
  "getphonenumber",
  "authorize",
  "authorize-confirm",
  "cloudfunction",
  "operatewxdata",
  "createshortlink",
  "getbusinessconfig",
  "getadvert",
  "verifyplugin",
  "search",
]);
export function checkBusinessResult(value: any) {
  if (!value || typeof value !== "object") return;
  for (const name of ["err_no", "errcode", "errCode"])
    if (
      (typeof value[name] === "number" ||
        (typeof value[name] === "string" && /^-?\d+$/.test(value[name]))) &&
      Number(value[name]) !== 0
    )
      throw Object.assign(
        Error(
          "wxbot business request rejected (" + name + "=" + value[name] + ")",
        ),
        {
          runnerCode: "WXBOT_BUSINESS_ERROR",
          remoteCode: value[name],
        },
      );
  if (value.baseresponse) checkBusinessResult(value.baseresponse);
}
export function parseBusinessJson(json: unknown) {
  if (typeof json !== "string" || !json.trim())
    throw Object.assign(
      Error(
        "wxbot returned no business JSON; permission or API response unavailable",
      ),
      { runnerCode: "WXBOT_EMPTY_RESULT" },
    );
  let value: any;
  try {
    value = JSON.parse(json);
  } catch {
    throw Object.assign(Error("wxbot returned malformed business JSON"), {
      runnerCode: "WXBOT_INVALID_RESULT",
    });
  }
  if (!value || typeof value !== "object")
    throw Object.assign(Error("wxbot returned invalid business JSON"), {
      runnerCode: "WXBOT_INVALID_RESULT",
    });
  checkBusinessResult(value);
  return value;
}
/** Only the supplied OpenAPI's mini-program group. No automatic retries. */
export class WxbotClient {
  constructor(
    private config: any,
    private log: Function = () => {},
  ) {}
  async raw(endpoint: string, extra: any = {}) {
    if (!endpoints.has(endpoint)) throw Error("Unknown mini-program endpoint");
    const c = this.config;
    if (!c.wxbot || !c.deviceId)
      throw Error(
        "wxbot is not configured (WXBOT_BASE and DEVICE_ID required)",
      );
    const url = gatewayURL(
      c.wxbot,
      endpoint === "search" ? "/mp/wxa/search" : "/miniprogram/" + endpoint,
    );
    if (!["http:", "https:"].includes(url.protocol))
      throw Error("wxbot must use HTTP(S)");
    const headers: any = { "content-type": "application/json" };
    if (c.appKey) headers["X-App-Key"] = c.appKey;
    if (c.appSecret) headers["X-App-Secret"] = c.appSecret;
    this.log("WXBOT OUT", url.pathname);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...extra, device_id: c.deviceId, appid: c.appid }),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    // A reverse proxy may return HTML for a missing endpoint. Keep the HTTP
    // status/code so callers can distinguish deployment gaps from bad JSON.
    if (!res.ok) {
      this.log("WXBOT IN", url.pathname, res.status);
      await res.body?.cancel().catch(() => {});
      throw Object.assign(Error("wxbot HTTP " + res.status), {
        runnerCode: "WXBOT_HTTP_ERROR",
        httpStatus: res.status,
      });
    }
    let raw: any;
    try {
      raw = await res.json();
    } catch {
      throw Error("wxbot HTTP " + res.status + ": invalid JSON response");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Object.assign(
        Error("wxbot returned an invalid response envelope"),
        { runnerCode: "WXBOT_INVALID_RESULT" },
      );
    this.log(
      "WXBOT IN",
      url.pathname,
      res.status,
      "ret=" + String(raw.ret ?? "unknown"),
    );
    if (
      raw.success === false ||
      raw.ok === false ||
      (raw.ret !== undefined && Number(raw.ret) !== 0) ||
      raw.error
    )
      throw Object.assign(
        Error(
          "wxbot rejected request (ret=" + String(raw.ret ?? "unknown") + ")",
        ),
        { runnerCode: "WXBOT_REJECTED" },
      );
    return raw;
  }
  async call(endpoint: string, extra: any = {}) {
    const raw = await this.raw(endpoint, extra);
    const data = Object.hasOwn(raw, "json")
      ? parseBusinessJson(raw.json)
      : (raw.data ?? raw);
    if (
      ["jslogin", "refreshsession"].includes(endpoint) &&
      (typeof data.code !== "string" || !data.code.trim())
    )
      throw Error("wxbot did not return a login code");
    return data;
  }
  async operate(data: any) {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed.api_name !== "string")
      throw Error("operatewxdata requires api_name");
    const raw = await this.raw("operatewxdata", { data: serialized });
    parseBusinessJson(raw.json);
    // The real base library parses the outer JSON and its serialized data field.
    return { data: raw.json };
  }
  async verifyPlugin(data: any) {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    let parsed: any;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw Error("verifyPlugin requires JSON data");
    }
    const plugins = parsed?.plugins;
    if (
      !Array.isArray(plugins) ||
      plugins.length < 1 ||
      plugins.length > 100 ||
      new Set(plugins.map((p) => p?.provider)).size !== plugins.length ||
      plugins.some(
        (p) =>
          !/^wx[0-9a-f]{16}$/i.test(p?.provider) ||
          !Number.isInteger(p.inner_version) ||
          p.inner_version < 0 ||
          p.inner_version > 0xffffffff,
      )
    )
      throw Error(
        "verifyPlugin requires unique providers and integer inner_version",
      );
    let raw: any;
    try {
      raw = await this.raw("verifyplugin", { data: serialized });
    } catch (e: any) {
      if (e.httpStatus === 404 || e.httpStatus === 501)
        throw Object.assign(
          Error(
            "wxbot /miniprogram/verifyplugin is unavailable; Runner received a native verification request, but this alone does not establish that the current business operation requires a new endpoint",
          ),
          { runnerCode: "PLUGIN_VERIFY_ENDPOINT_UNAVAILABLE" },
        );
      throw e;
    }
    const result = parseBusinessJson(raw.json);
    if (
      !Array.isArray(result.list) ||
      plugins.some(
        (p) => !result.list.some((item: any) => item?.plugin_id === p.provider),
      )
    )
      throw Object.assign(
        Error("verifyPlugin returned no result for a requested provider"),
        { runnerCode: "PLUGIN_VERIFY_INVALID_RESULT" },
      );
    // Preserve server banning/running flags, signatures and domain lists exactly.
    // The original SDK decides whether an individual plugin request is permitted.
    return { data: raw.json };
  }
}

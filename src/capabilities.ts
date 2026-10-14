export type Capability = {
  api: string;
  provider: "host" | "baselib" | "device-simulation" | "wxbot" | "excluded";
  callable: boolean;
  requires?: string;
};
/** Availability is independent of acceptance. Only explicit implementations are listed. */
export function capabilityRegistry(
  implemented: any,
  delegated: Set<string>,
  original: any,
  deviceApis: any,
): Capability[] {
  const account = new Set([
    "login",
    "getUserInfo",
    "getUserProfile",
    "getPhoneNumber",
    "cloud",
  ]);
  const rows: Capability[] = Object.keys(implemented)
    .filter(
      (k) =>
        typeof implemented[k] === "function" || k === "cloud" || k === "env",
    )
    .map((api) => ({
      api,
      provider:
        api === "requestPayment"
          ? "excluded"
          : account.has(api)
            ? "wxbot"
            : Object.hasOwn(deviceApis, api)
              ? "device-simulation"
              : "host",
      callable: api !== "requestPayment",
      ...(account.has(api)
        ? {
            requires:
              "configured wxbot; remote environment and authorization as applicable",
          }
        : {}),
    }));
  for (const api of delegated)
    rows.push({
      api,
      provider: "baselib",
      callable: original[api] != null,
      requires: "native dependencies vary by API; see acceptance matrix",
    });
  return rows.sort((a, b) => a.api.localeCompare(b.api));
}

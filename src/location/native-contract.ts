/** Native authorization uses an array; the public wx.authorize uses one scope. */
export function nativeAuthorization(args: any) {
  if (!Array.isArray(args?.scope)) return args;
  if (args.scope.length !== 1 || typeof args.scope[0] !== "string")
    throw Error("authorize requires exactly one scope");
  return { ...args, scope: args.scope[0] };
}

/** Account scopes come from bot; local hardware scopes always come from this host. */
export function mergeHardwareAuthorization(
  result: { data: string },
  setting: Record<string, boolean>,
) {
  const envelope = JSON.parse(result.data);
  const data = JSON.parse(envelope.data);
  if (!Array.isArray(data.auth_item))
    throw Error("Invalid authorization response: auth_item missing");
  const owned = new Set(["scope.camera", "scope.userLocation"]);
  data.auth_item = data.auth_item.filter((item: any) => !owned.has(item.scope));
  for (const scope of owned)
    if (typeof setting[scope] === "boolean")
      data.auth_item.push({ scope, state: setting[scope] ? 1 : 0 });
  return {
    ...result,
    data: JSON.stringify({ ...envelope, data: JSON.stringify(data) }),
  };
}

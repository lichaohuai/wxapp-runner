const secret =
  /^(?:authorization|cookie|set-cookie|api[-_]?key|x-app-key|x-app-secret|x-wechat-hostsign|host[-_]?sign|app[-_]?key|app[-_]?secret|access[-_]?token|refresh[-_]?token|token|session[-_]?key|password|encryptedData|iv|openid|unionid|phoneNumber|purePhoneNumber|phone_number|mobile|signature)$/i;
export function redact(value: any): any {
  // App data can shadow Array#map (including with a non-function). Never call
  // methods from the value being inspected while sanitizing diagnostic data.
  if (Array.isArray(value)) return Array.prototype.map.call(value, redact);
  if (value && typeof value === "object") {
    // CDP and HAR represent headers and query parameters as name/value pairs.
    if (
      typeof value.name === "string" &&
      (secret.test(value.name) || value.name === "code") &&
      "value" in value
    )
      return {
        ...redact(
          Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "value"),
          ),
        ),
        value: "[REDACTED]",
      };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secret.test(k) || (k === "code" && typeof v === "string")
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object")
      return JSON.stringify(redact(parsed));
  } catch {}
  const relativePath = /^\/(?!\/)[^\s]*\?/.test(value);
  if (relativePath || /^(?:https?|wss?):\/\//.test(value)) {
    try {
      const u = new URL(
        value,
        relativePath ? "http://redaction.invalid" : undefined,
      );
      if (u.username) u.username = "[REDACTED]";
      if (u.password) u.password = "[REDACTED]";
      for (const key of [...u.searchParams.keys()])
        if (secret.test(key) || key === "code")
          u.searchParams.set(key, "[REDACTED]");
      return relativePath ? u.pathname + u.search + u.hash : u.toString();
    } catch {}
  }
  const safe = value
    .replace(
      /^(:path:[ \t]*)([^\r\n]+)/gm,
      (_match, prefix, pathname) => prefix + redact(pathname),
    )
    .replace(/^(\s*([^:\r\n]+):)[^\r\n]*/gm, (match, prefix, key) =>
      secret.test(key.trim()) ? prefix + " [REDACTED]" : match,
    )
    .replace(/"([^"\n]+)"\s*:\s*"[^"\n]*(?:"|$)/g, (match, key) =>
      secret.test(key) || key === "code"
        ? JSON.stringify(key) + ':"[REDACTED]"'
        : match,
    );
  return safe.replace(
    /((?:token|password|app_secret|app_key|session_key|code)=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
}

/** Captured wire headers include transport metadata that Fetch must regenerate. */
export function replayHeaders(
  captured: Record<string, unknown>,
  originalUrl: string,
  replayUrl: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(captured).map(([name, value]) => [
      name.toLowerCase(),
      String(value),
    ]),
  );
  const transportHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    ...(headers.connection || "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  ]);
  for (const name of Object.keys(headers)) {
    // HTTP/2 :authority/:method/:path/:scheme are not HTTP header names.
    if (name.startsWith(":") || transportHeaders.has(name))
      delete headers[name];
  }
  if (new URL(originalUrl).origin !== new URL(replayUrl).origin) {
    delete headers.authorization;
    delete headers.cookie;
  }
  for (const [name, value] of Object.entries(overrides))
    headers[name.toLowerCase()] = value;
  // Explicit invalid overrides still fail before any request is sent.
  new Headers(headers);
  return headers;
}

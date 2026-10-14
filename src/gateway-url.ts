/** Retain a scoped gateway base path (for example a desktop session bridge).
 * Endpoint names are supplied by the host, never by mini-program business code.
 */
export function gatewayURL(base: string, endpoint: string) {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error("Gateway requires an HTTP(S) base without credentials, query or fragment");
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(endpoint) || endpoint.includes("//"))
    throw Error("Invalid gateway endpoint");
  url.pathname = url.pathname.replace(/\/+$/, "") + endpoint;
  return url;
}

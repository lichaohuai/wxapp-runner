/** Page options are strings, not application/x-www-form-urlencoded data. */
export function navigationTarget(
  url: string,
  currentRoute = "",
  nativeEncoded = false,
) {
  // The base library has already resolved native navigation against the page
  // and strips the leading slash. Resolving that path a second time would turn
  // sub/page into current/directory/sub/page. Direct shim/MCP URLs remain relative.
  const resolved =
    nativeEncoded && !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(url) ? "/" + url : url;
  const parsed = new URL(resolved, "https://package/" + currentRoute);
  const query: Record<string, string> = Object.create(null);
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  if (question >= 0 && (hash < 0 || question < hash)) {
    for (const part of url
      .slice(question + 1, hash < 0 ? undefined : hash)
      .split("&")) {
      if (!part) continue;
      const equals = part.indexOf("=");
      const key = equals < 0 ? part : part.slice(0, equals);
      let value = equals < 0 ? "" : part.slice(equals + 1);
      // Native calls passed through the base library's URL encoder; shim/MCP
      // calls did not. Undo only that transport layer, never business encoding.
      if (nativeEncoded) {
        try {
          value = decodeURIComponent(value);
        } catch {}
      }
      query[key] = value;
    }
  }
  return { pathname: parsed.pathname, query };
}

export function serviceRouteQuery(
  query: Record<string, string>,
  openType: string,
) {
  // 3.17.3 onAppRoute decodes non-launch values once before Page.onLoad.
  // Supply its transport encoding; the application's encodeURIComponent
  // layer must survive until its own onLoad decodes it. '+' stays literal.
  if (["appLaunch", "autoReLaunch"].includes(openType)) return { ...query };
  return Object.fromEntries(
    Object.entries(query).map(([k, v]) => [k, encodeURIComponent(v)]),
  );
}

/** PC lifecycle.ts getCurrentRoute returns both aliases from Navigator.currentRoute.
 * The official value is Page.path (including .html), without options/query.
 */
export function nativeCurrentRoute(route: string) {
  return { errMsg: "getCurrentRoute:ok", route, currentRoute: route };
}

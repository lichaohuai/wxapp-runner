import { navigationTarget } from "./navigation";
import { routeName } from "./paths";
import { RunnerError, diagnostic } from "../diagnostics";

export type LaunchTarget = { path: string; query: Record<string, string>; url: string };

/** External card paths are package-root routes, never URLs or filesystem paths.
 * Keep the original query encoding: the app, not form decoding, owns its values.
 */
export function resolveLaunchTarget(app: any, pagePath?: string): LaunchTarget {
  const input = pagePath === undefined ? app.entryPagePath : pagePath;
  const fail = (code: string, message: string): never => {
    throw new RunnerError(diagnostic(code, "package", message,
      "Use a page declared by this package, with its original query string."));
  };
  if (typeof input !== "string" || !input || input.length > 8192 ||
      /[\u0000-\u001f\u007f#]/.test(input))
    return fail("LAUNCH_PATH_INVALID", "Invalid mini-program launch path");
  const question = input.indexOf("?");
  const pathname = question < 0 ? input : input.slice(0, question);
  const suffix = question < 0 ? "" : input.slice(question);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return fail("LAUNCH_PATH_INVALID", "Malformed launch path encoding"); }
  if (!pathname || pathname.startsWith("//") || /[:\\?#\u0000-\u001f\u007f]/.test(decoded) ||
      decoded !== pathname || pathname.replace(/^\//, "").split("/").some(p => !p || p === "." || p === ".."))
    return fail("LAUNCH_PATH_INVALID", "Launch path must stay within the mini-program");
  const route = routeName(pathname);
  const declared = new Set<string>((app.pages || []).map((p: string) => routeName(p)));
  for (const sub of app.subPackages || app.subpackages || [])
    for (const page of sub.pages || [])
      declared.add(routeName(sub.root.replace(/\/$/, "") + "/" + page));
  if (!declared.has(route))
    return fail("LAUNCH_PAGE_NOT_REGISTERED", "Launch page is absent from this package's pages");
  const url = route + suffix;
  return { path: route, query: navigationTarget(url).query, url };
}

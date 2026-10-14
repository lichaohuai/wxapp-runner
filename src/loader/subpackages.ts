import { hasFile, routeName } from "./paths";
import { diagnostic, RunnerError } from "../diagnostics";

/** Resolve local module bootstraps without downloading or executing anything.
 * Chunk files remain lazy: the real base library loads registered chunks when
 * require.async or a page first needs them.
 */
export function localSubpackage(packageDir: string, app: any, name: unknown) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("..") ||
    name.includes("\\")
  )
    throw Error("Invalid subpackage name");
  const normalized = routeName(name).replace(/\/$/, "");
  const sub = (app.subPackages || []).find(
    (p: any) =>
      routeName(p.root).replace(/\/$/, "") === normalized ||
      p.name === name ||
      p.alias === name,
  );
  if (!sub) throw Error("Subpackage is not registered: " + name);
  const root = routeName(sub.root).replace(/\/?$/, "/");
  const entry = [root + "appservice.app.js", root + "app-service.js"].find(
    (f) => hasFile(packageDir, f),
  );
  if (!entry)
    throw new RunnerError(
      diagnostic(
        "SUBPACKAGE_LOGIC_MISSING",
        "package",
        "Subpackage logic entry is missing",
        "Provide the decrypted subpackage before loading it.",
        { file: root + "appservice.app.js" },
      ),
    );
  return {
    moduleName: "/" + root,
    files: [
      ...(hasFile(packageDir, root + "common.app.js")
        ? [root + "common.app.js"]
        : []),
      entry,
    ],
  };
}

// Keep the public Electron entry; runtime children never own the public endpoint.
import path from "node:path";
// A packaged build has no app-path argv entry, so flags start one slot earlier.
const argv = process.argv.slice((process as any).defaultApp ? 2 : 1);
const subcommands: Record<string, string> = {
  mcp: "mcp.cjs",
  packages: "packages.cjs",
};
const subcommand = subcommands[argv[0]];
if (subcommand) {
  // Hand the sub-entry a plain-node argv shape ([execPath, script, ...flags])
  // so its own flag parsing behaves exactly like `node dist/<entry>`. This lets
  // the shipped executable serve the stdio MCP server and the package CLI
  // without a separate Node installation or an asar-internal script path.
  const script = path.join(__dirname, subcommand);
  process.argv = [process.argv[0], script, ...argv.slice(1)];
  require(script);
} else {
  const entry =
    process.env.WXAPP_RUNTIME_CHILD || process.env.WXAPP_STANDALONE
      ? "runtime-main.cjs"
      : "supervisor-main.cjs";
  require(path.join(__dirname, entry));
}

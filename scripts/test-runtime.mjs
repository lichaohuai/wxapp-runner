import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function isolatedRuntime() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-smoke-"));
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, "{}", { mode: 0o600 });
  const env = { ...process.env, WXAPP_STANDALONE: "1" };
  for (const key of [
    "WXBOT_BASE",
    "APP_KEY",
    "APP_SECRET",
    "DEVICE_ID",
    "APPID",
    "WXAPP_DEBUG_PORT",
  ])
    delete env[key];
  return {
    directory,
    args: ["--config", config, "--user-data", path.join(directory, "data")],
    env,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

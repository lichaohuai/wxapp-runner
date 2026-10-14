import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PackageManager } from "./manager";
const i = process.argv.indexOf("--root");
if (i < 0 || !process.argv[i + 1]) throw Error("--root required");
const root = path.resolve(process.argv[i + 1]),
  lock = path.join(root, ".service-lock");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
try {
  fs.mkdirSync(lock);
} catch {
  let stale = false;
  try {
    const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      stale = e.code === "ESRCH";
    }
  } catch {
    stale = Date.now() - fs.statSync(lock).mtimeMs > 10000;
  }
  if (!stale) process.exit(0);
  fs.rmSync(lock, { recursive: true, force: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    process.exit(0);
  }
}
fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
const manager = new PackageManager(root),
  token = randomBytes(32).toString("hex");
let lastUse = Date.now();
const server = http.createServer(async (req, res) => {
  const supplied = Buffer.from(req.headers.authorization || ""),
    expected = Buffer.from("Bearer " + token);
  const send = (status: number, value: any) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    send(401, { error: "Unauthorized" });
    return;
  }
  lastUse = Date.now();
  if (req.url === "/health" && req.method === "GET") {
    send(200, { service: "wxapp-packages", version: 1, pid: process.pid });
    return;
  }
  if (req.url !== "/call" || req.method !== "POST") {
    send(404, { error: "Not found" });
    return;
  }
  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw Error("Request too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof body.configFile !== "string") throw Error("configFile required");
    const result = await manager.dispatch(
      body.args,
      body.configFile,
      abort.signal,
    );
    send(200, { result });
  } catch (e: any) {
    if (!res.destroyed)
      send(400, {
        code: e.code || "PACKAGE_INVALID_REQUEST",
        error: e.name === "ZodError" ? "Invalid package arguments" : e.message,
      });
  }
});
const file = path.join(root, "service.json");
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as any).port,
    tmp = file + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      endpoint: `http://127.0.0.1:${port}`,
      token,
    }),
    { mode: 0o600 },
  );
  fs.renameSync(tmp, file);
});
const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("exit", () => {
  try {
    if (
      Number(fs.readFileSync(path.join(lock, "pid"), "utf8")) === process.pid
    ) {
      fs.rmSync(lock, { recursive: true, force: true });
      if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid)
        fs.rmSync(file, { force: true });
    }
  } catch {}
});
setInterval(() => {
  if (
    Date.now() - lastUse > 10 * 60 * 1000 &&
    ![...manager.jobs.values()].some((j) => j.status === "running")
  )
    stop();
}, 30000).unref();

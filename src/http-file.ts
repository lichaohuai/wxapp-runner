import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
const types: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
};
export function fileContentType(file: string) {
  return types[path.extname(file).toLowerCase()] || "application/octet-stream";
}
/** The caller resolves and authorizes the path before serving it. No full-file buffering. */
export function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  res.setHeader("Content-Type", fileContentType(file));
  res.setHeader("Accept-Ranges", "bytes");
  let start = 0,
    end = stat.size - 1;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else start = Math.max(0, stat.size - Number(range[2]));
    }
    if (
      !range ||
      !(range[1] || range[2]) ||
      !Number.isSafeInteger(start) ||
      start >= stat.size ||
      end < start
    ) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader("Content-Length", Math.max(0, end - start + 1));
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", (error) => res.destroy(error));
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

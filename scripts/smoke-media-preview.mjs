import { managedFixture, until } from "./managed-test-runtime.mjs";
import { createCanvas } from "@napi-rs/canvas";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const canvas = createCanvas(32, 24),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "#32a852";
ctx.fillRect(0, 0, 32, 24);
const wav = Buffer.alloc(44 + 1600);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(1600, 40);
const resources = {
  "preview.png": { mime: "image/png", body: canvas.toBuffer("image/png") },
  "cached.png": { mime: "image/png", body: canvas.toBuffer("image/png") },
  "preview.jpg": { mime: "image/jpeg", body: canvas.toBuffer("image/jpeg") },
  "preview.webp": { mime: "image/webp", body: canvas.toBuffer("image/webp") },
  "preview.svg": {
    mime: "image/svg+xml",
    body: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#32a852"/></svg>',
    ),
  },
  "preview.wav": { mime: "audio/wav", body: wav },
  "preview.webm": {
    mime: "video/webm",
    body: fs.readFileSync("tests/fixtures/media/preview.webm"),
  },
};
const requests = [];
const server = http.createServer((req, res) => {
  const name = req.url.slice(1),
    item = resources[name];
  requests.push(name);
  if (!item) return res.writeHead(404).end();
  res.writeHead(200, {
    "Content-Type": item.mime,
    "Content-Length": item.body.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":
      name === "cached.png" ? "public, max-age=3600" : "no-store",
  });
  res.end(item.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const out = path.resolve("docs/evidence/media-preview-2026-09-12");
fs.mkdirSync(out, { recursive: true });
let t, debug;
try {
  t = await managedFixture();
  const { call } = t;
  const targetId = "page:" + (await call("runner_status")).current.id;
  const evalView = async (expression) => {
    const r = await call("runner_evaluate", {
      targetId,
      expression,
      awaitPromise: true,
    });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  // Warm the HTTP cache, then load the same resource as an image. No reload of a user page.
  await evalView(
    `fetch(${JSON.stringify(endpoint + "/cached.png")}).then(r=>r.arrayBuffer()).then(b=>b.byteLength)`,
  );
  for (const [name, item] of Object.entries(resources)) {
    const tag = item.mime.startsWith("image/")
      ? "img"
      : item.mime.startsWith("video/")
        ? "video"
        : "audio";
    const loaded =
      await evalView(`new Promise(resolve=>{const e=document.createElement('${tag}');e.id=${JSON.stringify(name)};e.style.cssText='width:64px;height:48px';
      e.addEventListener('${tag === "img" ? "load" : "loadeddata"}',()=>resolve({loaded:true,width:e.naturalWidth||e.videoWidth||null}));
      e.onerror=()=>resolve({loaded:false});e.preload='auto';e.src=${JSON.stringify(endpoint + "/" + name)};document.body.append(e);})`);
    assert.equal(loaded.loaded, true, name + " must load in the page");
  }
  const rows = await until(async () => {
    const r = await call("runner_network", {
      filter: { urlIncludes: endpoint },
      limit: 30,
      maxScan: 1000,
    });
    const rows = r.entries.filter((r) =>
      ["Image", "Media"].includes(r.resourceType),
    );
    return (
      rows.length >= Object.keys(resources).length &&
      rows.every((r) => r.state === "complete") &&
      rows
    );
  });
  for (const row of rows) {
    const name = new URL(row.url).pathname.slice(1),
      item = resources[name];
    const r = await call("runner_network", { id: row.id });
    assert.equal(r.mimeType, item.mime);
    assert.equal(
      r.responseBodyCapture.bytes,
      item.body.length,
      name + " captured bytes",
    );
    assert.equal(r.responseBodyCapture.error, undefined);
    const a = await call("runner_artifact", {
      action: "read",
      id: r.responseArtifactId,
      revealSensitive: true,
    });
    assert.deepEqual(
      Buffer.from(a.data, "base64"),
      item.body,
      name + " retained bytes",
    );
    assert.deepEqual(
      await call("runner_artifact", {
        action: "read",
        id: r.responseArtifactId,
        revealSensitive: true,
      }),
      a,
    );
  }
  const countBeforePreview = requests.length;
  await call("runner_debugger", { action: "open" });
  debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Network", exact: true }).click();
  const previews = [];
  for (const [name, item] of Object.entries(resources)) {
    await debug
      .getByRole("cell", {
        name: item.mime.startsWith("image/") ? `Image ${name}` : name,
        exact: true,
      })
      .first()
      .click();
    await debug.getByRole("tab", { name: "Preview", exact: true }).click();
    const expectedTag = item.mime.startsWith("image/")
      ? "IMG"
      : item.mime.startsWith("video/")
        ? "VIDEO"
        : "AUDIO";
    const preview = await until(
      () =>
        debug.locator("img,video,audio").evaluateAll(
          (elements, expected) =>
            elements
              .filter((e) => e.getBoundingClientRect().width > 0)
              .map((e) => ({
                tag: e.tagName,
                alt: e.alt,
                src: e.currentSrc || e.src,
                width: e.naturalWidth || e.videoWidth || null,
                height: e.naturalHeight || e.videoHeight || null,
                ready: e.readyState,
              }))
              .find(
                (e) =>
                  e.tag === expected.tag &&
                  (expected.tag === "IMG"
                    ? e.alt === "Image from " + expected.url &&
                      e.width === 32 &&
                      e.height === 24
                    : e.ready >= 2),
              ),
          { tag: expectedTag, url: endpoint + "/" + name },
        ),
      10000,
    );
    previews.push({
      name,
      tag: preview.tag,
      width: preview.width,
      ready: preview.ready,
    });
    if (expectedTag !== "IMG") {
      const played = await debug
        .getByLabel("Captured media preview", { exact: true })
        .evaluate(
          (e) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(Error("captured media playback did not finish")),
                5000,
              );
              e.addEventListener(
                "ended",
                () => {
                  clearTimeout(timer);
                  resolve(e.currentTime > 0);
                },
                { once: true },
              );
              e.play().catch((error) => {
                clearTimeout(timer);
                reject(error);
              });
            }),
        );
      assert.equal(played, true, name + " actual local playback");
      previews.at(-1).played = true;
    }
    if (name === "preview.png" || name === "preview.webm")
      await debug.screenshot({ path: path.join(out, name + "-f12.png") });
  }
  assert.equal(
    requests.length,
    countBeforePreview,
    "preview must use cache, not re-request the URL",
  );
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    previews,
    retainedBytesExact: true,
    mcpRepeatedReads: true,
    lateF12Preview: true,
    noPreviewRefetch: true,
  };
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  fs.rmSync(path.join(out, "result.json"), { force: true });
  fs.mkdirSync(".local/media-preview", { recursive: true });
  fs.writeFileSync(".local/media-preview/failed.log", t?.logs.join("") || "");
  if (debug) {
    fs.writeFileSync(
      ".local/media-preview/ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
    await debug.screenshot({ path: ".local/media-preview/failed.png" });
  }
  throw error;
} finally {
  await t?.close();
  server.closeAllConnections();
  server.close();
}

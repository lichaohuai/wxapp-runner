import { managedFixture, until } from "./managed-test-runtime.mjs";
import { videoFixture } from "./native-video-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
import { serveFile } from "../src/http-file.ts";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wx-video-"));
const results = [];
const server = http.createServer((req, res) =>
  serveFile(req, res, path.resolve("tests/fixtures/native-video.mp4")),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const source = "http://127.0.0.1:" + server.address().port + "/clip.mp4";
try {
  for (const framework of ["glass-easel", "exparser"]) {
    const t = await managedFixture({
      packageDir: videoFixture(directory, framework, source),
    });
    try {
      const targetId = "page:" + (await t.call("runner_status")).current.id;
      const evalView = async (expression) => {
        const r = await t.call("runner_evaluate", {
          targetId,
          expression,
          awaitPromise: true,
        });
        assert.ok(!r.exceptionDetails, JSON.stringify(r));
        return r.result.value;
      };
      await until(
        async () =>
          await evalView(
            `!!document.querySelector('video')?.videoWidth && document.querySelector('#metadata')?.textContent==='true'`,
          ),
      );
      assert.equal(
        await evalView(`document.querySelector('#metadata').textContent`),
        "true",
      );
      const instance = (await t.call("runner_native")).instances.find(
        (i) => i.kind === "video",
      );
      assert.equal(instance.backend, "video");
      const resource = await evalView(
        `fetch('/page/component/resources/clip.mp4').then(async r=>({type:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}))`,
      );
      assert.match(resource.type, /mp4/);
      assert.ok(resource.bytes > 1000);
      await t.call("runner_click", { selector: "#play" });
      await until(
        async () =>
          await evalView(
            `document.querySelector('#state').textContent==='played' && Number(document.querySelector('#time').textContent)>0`,
          ),
      );
      await t.call("runner_click", { selector: "#pause" });
      await until(
        async () =>
          await evalView(
            `document.querySelector('#state').textContent==='paused' && document.querySelector('video').paused`,
          ),
      );
      await t.call("runner_click", { selector: "#seek" });
      await until(
        async () =>
          await evalView(`document.querySelector('video').currentTime>=2`),
      );
      await t.call("runner_click", { selector: "#danmu" });
      await until(
        async () =>
          await evalView(
            `document.querySelector('[data-runner-danmu]')?.textContent==='中文弹幕'`,
          ),
      );
      await t.call("runner_native", {
        action: "seek",
        id: instance.id,
        position: 5.8,
      });
      await t.call("runner_native", { action: "play", id: instance.id });
      await until(
        async () =>
          await evalView(
            `document.querySelector('#state').textContent==='ended'`,
          ),
      );
      await t.call("runner_click", { selector: "#remove" });
      await until(
        async () =>
          !(await t.call("runner_native")).instances.some(
            (i) => i.kind === "video",
          ),
      );
      const stale = await t.client.callTool({
        name: "runner_native",
        arguments: { action: "play", id: instance.id },
      });
      assert.equal(stale.isError, true);
      results.push({
        framework,
        status: "验收通过",
        metadata: true,
        resourcePathRegression: true,
        originalHandlerControls: ["play", "pause", "seek", "sendDanmu"],
        realPlaybackAndEnded: true,
        destroyed: true,
      });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      console.error(JSON.stringify(await t.call("runner_native")));
      console.error(t.logs.join("").slice(-3500));
      throw error;
    } finally {
      await t.close();
    }
  }
  fs.writeFileSync(
    "docs/native-video-result.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        platform: process.platform,
        fixture: "isolated generated MP4, real baselib",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  server.closeAllConnections();
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

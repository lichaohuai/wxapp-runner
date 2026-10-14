import { managedFixture, until } from "./managed-test-runtime.mjs";
import { cameraMapFixture } from "./native-camera-map-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import z from "@zxing/library";
import { PNG } from "pngjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-camera-map-")),
  results = [];
const qrFile = path.join(dir, "qr.png"),
  matrix = new z.QRCodeWriter().encode(
    "https://example.test/scan?value=中文",
    z.BarcodeFormat.QR_CODE,
    480,
    640,
    new Map([[z.EncodeHintType.CHARACTER_SET, "UTF-8"]]),
  ),
  png = new PNG({ width: 480, height: 640 });
for (let y = 0; y < 640; y++)
  for (let x = 0; x < 480; x++) {
    const i = (y * 480 + x) * 4,
      v = matrix.get(x, y) ? 0 : 255;
    png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
    png.data[i + 3] = 255;
  }
fs.writeFileSync(qrFile, PNG.sync.write(png));
try {
  for (const framework of ["exparser", "glass-easel"]) {
    const t = await managedFixture({
      packageDir: cameraMapFixture(dir, framework),
    });
    try {
      await t.call("runner_navigate", { method: "navigateTo", url: "/next" });
      await until(
        async () => (await t.call("runner_status")).current.route === "next",
      );
      await t.call("runner_navigate", { method: "navigateTo", url: "/home" });
      await until(async () => {
        const s = await t.call("runner_status");
        return s.current.route === "home" && s.current.ready;
      });
      const targetId = "page:" + (await t.call("runner_status")).current.id;
      const view = async (expression) => {
        const r = await t.call("runner_evaluate", {
          targetId,
          expression,
          awaitPromise: true,
        });
        if (r.exceptionDetails) throw Error(JSON.stringify(r));
        return r.result.value;
      };
      await until(
        async () =>
          !!(await t.call("runner_native")).instances.find(
            (x) => x.map?.markerCount === 1,
          ),
      );
      await until(
        async () =>
          await view(
            `getComputedStyle(document.querySelector('#cover-button')).visibility==='visible'`,
          ),
      );
      await t.call("runner_click", { selector: "#cover-button" });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('cover-tap|')`,
          ),
      );
      await t.call("runner_gesture", {
        action: "scroll",
        selector: "#cover-scroll",
        deltaY: 100,
      });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('cover-scroll|')`,
          ),
      );
      await t.call("runner_click", { selector: "#coverToggle" });
      await until(
        async () => !(await view(`!!document.querySelector('#cover')`)),
      );
      await t.call("runner_click", { selector: "#coverToggle" });
      await until(
        async () =>
          await view(
            `getComputedStyle(document.querySelector('#cover-button')).visibility==='visible'`,
          ),
      );
      await t.call("runner_click", { selector: ".leaflet-marker-icon" });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('marker:7|')`,
          ),
      );
      await t.call("runner_click", { selector: "#center" });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('center-ok|')`,
          ),
      );
      await t.call("runner_click", { selector: "#authorize" });
      const dialog = await until(async () =>
        (await t.call("runner_dialog")).find((d) => d.name === "authorize"),
      );
      assert.equal(dialog.args.scope, "scope.camera");
      await t.call("runner_dialog", {
        action: "respond",
        id: dialog.id,
        confirm: true,
      });
      const cam = await until(async () =>
        (await t.call("runner_native")).instances.find(
          (x) => x.kind === "camera" && x.camera,
        ),
      );
      await t.call("runner_native", {
        action: "camera-input",
        id: cam.id,
        mode: "simulated",
      });
      await until(
        async () =>
          await view(
            `Number(document.querySelector('#result').textContent.split('|')[1])>0`,
          ),
      );
      await t.call("runner_native", {
        action: "scan",
        id: cam.id,
        result: "测试扫码😀",
      });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('测试扫码😀|')`,
          ),
      );
      await t.call("runner_native", {
        action: "camera-input",
        id: cam.id,
        mode: "image",
        file: qrFile,
      });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('https://example.test/scan?value=中文|')`,
          ),
      );
      await t.call("runner_click", { selector: "#remove" });
      await until(
        async () =>
          !(await t.call("runner_native")).instances.some(
            (x) => x.kind === "camera",
          ),
      );
      const stale = await t.client.callTool({
        name: "runner_native",
        arguments: { action: "scan", id: cam.id, result: "stale" },
      });
      assert.equal(stale.isError, true);
      await t.call("runner_click", { selector: "#scanner" });
      const scanner = await until(async () =>
        (await t.call("runner_native")).instances.find(
          (x) => x.kind === "camera" && x.camera,
        ),
      );
      await t.call("runner_native", {
        action: "camera-input",
        id: scanner.id,
        mode: "simulated",
      });
      await t.call("runner_native", {
        action: "scan",
        id: scanner.id,
        result: "standalone-扫码",
      });
      await until(
        async () =>
          await view(
            `document.querySelector('#result').textContent.startsWith('standalone-扫码|')`,
          ),
      );
      results.push({
        framework,
        status: "验收通过",
        mapMarkerHandler: true,
        coverVisible: true,
        coverOriginalHandler: true,
        coverScrollCallback: true,
        coverWheel: true,
        coverRecreated: true,
        mapContextCenter: true,
        secondaryPageCamera: true,
        cameraPermission: true,
        cameraFrames: true,
        scanOriginalHandler: true,
        imageQrDecoded: true,
        standaloneScan: true,
        staleRejected: true,
      });
      console.log(JSON.stringify(results.at(-1)));
    } catch (e) {
      console.error(
        "COVER",
        JSON.stringify(
          (
            await t.call("runner_evaluate", {
              targetId: "page:" + (await t.call("runner_status")).current.id,
              expression: `[...document.querySelectorAll('wx-cover-view')].map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON(),css:{display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,pointerEvents:getComputedStyle(e).pointerEvents},child:[...e.children].map(x=>({rect:x.getBoundingClientRect().toJSON(),display:getComputedStyle(x).display,visibility:getComputedStyle(x).visibility}))}))`,
            })
          ).result,
        ),
      );
      fs.writeFileSync(".local/camera-map-failure.log", t.logs.join(""));
      console.error(
        "SNAPSHOT",
        JSON.stringify(await t.call("runner_snapshot")),
      );
      console.error("STATE", JSON.stringify(await t.call("runner_state")));
      console.error("NATIVE", JSON.stringify(await t.call("runner_native")));
      console.error(t.logs.join("").slice(-6500));
      throw e;
    } finally {
      await t.close();
    }
  }
  fs.writeFileSync(
    "docs/camera-map-result.json",
    JSON.stringify(
      { at: new Date().toISOString(), platform: process.platform, results },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

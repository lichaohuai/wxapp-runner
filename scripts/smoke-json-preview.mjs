import { managedFixture, until } from "./managed-test-runtime.mjs";
import http from "node:http";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const inner = {
  baseresponse: {
    errcode: 0,
    stat: { qbase_cost_time: 144, func_exec_cost_time: 23 },
  },
  response_data: JSON.stringify({
    service_errcode: 0,
    result: { message: "云函数中文🙂", token: "fixture-secret" },
  }),
};
const raw = JSON.stringify({
  ok: true,
  ret: 0,
  json: JSON.stringify({ err_no: 0, data: JSON.stringify(inner) }),
});
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(gzipSync(raw));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const out = path.resolve("docs/evidence/json-preview-2026-09-12");
fs.mkdirSync(out, { recursive: true });
let t, debug;
try {
  t = await managedFixture({
    url: endpoint + "/cloud-envelope",
    beforeStart({ packageDir }) {
      const file = path.join(packageDir, "app-service.js");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            "submit(){wx.request(",
            "submit(){internals.__appServiceSDK__.wx.request(",
          )
          .replace(
            "success:r=>this.setData({result:r.data.message})",
            "success:r=>{globalThis.fixtureResponse=r.data;this.setData({result:typeof r.data.json==='string'?'业务收到原始字符串':'格式被改变'})}",
          ),
      );
    },
  });
  const { call } = t;
  assert.equal(
    (await call("runner_wait", { kind: "element", selector: "#submit" }))
      .status,
    "matched",
  );
  await call("runner_input", {
    selector: "textarea",
    text: "JSON preview fixture",
  });
  await call("runner_click", { selector: "#submit" });
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "业务收到原始字符串" }))
      .status,
    "matched",
  );
  const evaluated = await call("runner_evaluate", {
    expression: "fixtureResponse",
  });
  assert.equal(typeof evaluated.result.value.json, "string");
  // View resource capture and logic transport must expose the same decoded preview.
  const targetId = "page:" + (await call("runner_status")).current.id;
  const viewed = await call("runner_evaluate", {
    targetId,
    awaitPromise: true,
    expression: `fetch(${JSON.stringify(endpoint + "/view-envelope")}).then(r=>r.json()).then(r=>typeof r.json)`,
  });
  assert.equal(viewed.result.value, "string");
  const records = await until(async () => {
    const { entries } = await call("runner_network", {
      filter: { urlIncludes: endpoint },
      limit: 10,
    });
    return (
      entries.length === 2 &&
      entries.every((r) => r.state === "complete") &&
      entries
    );
  });
  for (const row of records) {
    const detail = await call("runner_network", { id: row.id });
    const p = detail.responseBodyPreview;
    assert.equal(
      p.decoded.json.data.response_data.result.message,
      "云函数中文🙂",
    );
    assert.equal(p.decoded.json.data.response_data.result.token, "[REDACTED]");
    assert.equal(typeof p.parsed.json, "string");
    assert.equal(p.decoding.paths.length, 3);
    assert.ok(!JSON.stringify(detail).includes("fixture-secret"));
    assert.equal(
      (await call("runner_network", { id: row.id, revealSensitive: true }))
        .responseBody,
      raw,
    );
    assert.deepEqual(await call("runner_network", { id: row.id }), detail);
  }
  const countBeforePreview = requests;
  await call("runner_debugger", { action: "open" });
  debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Network", exact: true }).click();
  for (const name of ["cloud-envelope", "view-envelope"]) {
    await debug
      .getByRole("cell", { name: `Fetch ${name}`, exact: true })
      .click();
    await debug.getByRole("tab", { name: "Preview", exact: true }).click();
    await debug
      .getByRole("status")
      .filter({ hasText: "已展开 3 处 JSON 字符串" })
      .waitFor();
    // Expand the native JSONView tree using keyboard input, not an injected tree.
    for (const key of [
      "json",
      "data",
      "baseresponse",
      "stat",
      "response_data",
      "result",
    ]) {
      const item = debug
        .getByRole("treeitem", { name: new RegExp(`^${key}\\s*:`) })
        .first();
      await item.click();
      await item.press("ArrowRight");
    }
    const tree = await debug.locator("body").ariaSnapshot();
    assert.match(tree, /func_exec_cost_time\s*: 23/);
    assert.match(tree, /云函数中文🙂/);
    assert.ok(!tree.includes("fixture-secret"));
    if (name === "cloud-envelope")
      await debug.screenshot({ path: path.join(out, "f12-decoded.png") });
    await debug
      .getByRole("button", { name: "查看原始结构", exact: true })
      .click();
    await debug
      .getByRole("button", { name: "查看解析结构", exact: true })
      .waitFor();
    const original = await debug
      .getByRole("treeitem", { name: /^json\s*:/ })
      .first()
      .innerText();
    assert.match(original, /\\"/);
    await debug
      .getByRole("button", { name: "查看解析结构", exact: true })
      .click();
    // Response stays the original serialized envelope, rather than expanded data.
    await debug.getByRole("tab", { name: "Response", exact: true }).click();
    await debug
      .getByText(/qbase_cost_time/)
      .first()
      .waitFor();
    const responseUI = await debug
      .locator(".cm-content:visible")
      .first()
      .innerText();
    assert.equal(typeof JSON.parse(responseUI).json, "string");
    assert.equal(JSON.parse(JSON.parse(responseUI).json).err_no, 0);
    if (name === "cloud-envelope")
      await debug.screenshot({ path: path.join(out, "f12-response.png") });
  }
  for (const row of records) {
    assert.equal(
      (await call("runner_network", { id: row.id, revealSensitive: true }))
        .responseBody,
      raw,
    );
    const detail = await call("runner_network", { id: row.id });
    const a = await call("runner_artifact", {
      action: "read",
      id: detail.responseArtifactId,
      revealSensitive: true,
    });
    assert.equal(Buffer.from(a.data, "base64").toString(), raw);
  }
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await debug.getByLabel("Wxapp section", { exact: true }).selectOption("请求");
  await debug.getByLabel("请求 ID A", { exact: true }).fill(records[0].id);
  await debug
    .getByRole("button", { name: "读取请求详情", exact: true })
    .click();
  await debug.getByText("响应 · 已展开 JSON 字符串", { exact: true }).waitFor();
  const wxapp = await debug
    .getByLabel("Wxapp result", { exact: true })
    .innerText();
  assert.match(wxapp, /云函数中文🙂/);
  assert.ok(!wxapp.includes("fixture-secret"));
  assert.equal(
    requests,
    countBeforePreview,
    "Preview must not resend requests",
  );
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    sources: records.map((r) => r.source),
    nativeJsonTree: true,
    originalToggle: true,
    responseUnchanged: true,
    chineseGzip: true,
    businessStringsUnchanged: true,
    credentialsRedacted: true,
    repeatedF12MCPReads: true,
    originalArtifactsExact: true,
    wxappPanelDecoded: true,
    previewRefetches: 0,
  };
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  fs.rmSync(path.join(out, "result.json"), { force: true });
  fs.mkdirSync(".local/json-preview", { recursive: true });
  fs.writeFileSync(".local/json-preview/failed.log", t?.logs.join("") || "");
  if (debug) {
    fs.writeFileSync(
      ".local/json-preview/ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
    await debug.screenshot({ path: ".local/json-preview/failed.png" });
  }
  throw error;
} finally {
  await t?.close();
  server.closeAllConnections();
  server.close();
}

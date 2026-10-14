import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import { until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
const isolated = isolatedRuntime(),
  connection = path.join(isolated.directory, "mcp.json");
let count = 0;
const server = http.createServer(async (req, res) => {
  count++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader("content-type", "application/json");
  res.setHeader("content-encoding", "gzip");
  res.end(gzipSync(Buffer.from(JSON.stringify({
    message: "结果:" + data.message
  }))));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/probe`;
const pkg = interactionFixture(isolated.directory, url);
const app = await electron.launch({
  args: [".", "--package", pkg, "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--devtools", "--mcp", "--mcp-file", connection, ...isolated.args],
  env: {
    ...isolated.env,
    WXAPP_STANDALONE: ""
  },
  cwd: process.cwd()
});
const logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
const client = new Client({
  name: "p4-acceptance",
  version: "1"
});
async function call(name, args = {}, options) {
  const r = await client.callTool({
    name,
    arguments: args
  }, undefined, options);
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
const wait = async args => {
  const result = await call("runner_wait", args, {
    timeout: 65000
  });
  assert.equal(result.status, "matched", JSON.stringify(result));
  return result.result;
};
try {
  // Boot only; all application interactions below use condition waits through standard MCP.
  for (let n = 0; !fs.existsSync(connection) && n < 100; n++) await new Promise(r => setTimeout(r, 50));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  await wait({
    kind: "element",
    selector: "textarea"
  });
  console.log("fixture-ready");
  // Read real base-library startup logs through the same path as app diagnostics.
  // Business contexts intentionally do not expose the service's native invoke API.
  let logCursor = 0;
  const systemLogs = [];
  await until(async () => {
    const page = await call("runner_logs", {
      after: logCursor,
      limit: 200
    });
    assert.equal(page.gap, false);
    logCursor = page.nextCursor;
    systemLogs.push(...page.entries.filter(e => e.args?.[0] === "[native.systemLog]"));
    return ["logic", "view"].every(source => systemLogs.some(e => e.source === source)) && systemLogs.some(e => e.source === "logic" && e.args[1].some(message => /[\u4e00-\u9fff]/.test(message) && message.includes("\n")));
  });
  assert.ok(systemLogs.every(e => Array.isArray(e.args[1])));
  assert.ok(systemLogs.some(e => e.source === "logic" && e.args[1].some(message => /[\u4e00-\u9fff]/.test(message) && message.includes("\n"))));
  const debug = app.windows().find(p => p.url().includes("js_app.html"));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  await call("runner_input", {
    selector: "textarea",
    text: "中文输入😀"
  });
  const before = (await call("runner_status")).networkCursor;
  const submission = await call("runner_click", {
    selector: "#submit"
  });
  const record = await wait({
    kind: "network",
    after: before,
    urlIncludes: "/probe"
  });
  assert.equal(record.context.rootHandler, "submit");
  assert.equal(record.context.rootOperationId, submission.operationId);
  assert.equal(record.context.api, "wx.request");
  assert.match(record.callStack, /app-service\.js/);
  assert.equal(JSON.parse((await call("runner_network", {
    id: record.id
  })).requestBody).message, "中文输入😀");
  await wait({
    kind: "text",
    text: "结果:中文输入😀"
  });
  assert.equal(count, 1);
  const state = await call("runner_state");
  const instanceId = state.pages[0].instanceId;
  const mapping = await call("runner_state", {
    action: "locate",
    instanceId,
    selector: "#submit"
  });
  assert.equal(mapping.mapping, "public-scoped-selector-query");
  assert.equal(mapping.rects.length, 1);
  assert.ok(mapping.rects[0].width > 0);
  await wait({
    kind: "state",
    instanceId,
    path: ["result"],
    equals: "结果:中文输入😀"
  });
  await call("runner_state", {
    action: "setData",
    instanceId,
    patch: {
      result: "debug-patch"
    }
  });
  await wait({
    kind: "text",
    text: "debug-patch"
  });
  await call("runner_click", {
    selector: "#modal"
  });
  const modal = await wait({
    kind: "dialog",
    dialogType: "showModal"
  });
  await until(async () => (await call("runner_status")).pendingDialogs?.some(d => d.id === modal.id && d.status === "awaiting-response"));
  await debug.getByRole("combobox", {
    name: "Wxapp section"
  }).selectOption({
    label: "加载链路"
  });
  await debug.getByText("等待 1 个对话框回复（showModal）", {
    exact: false
  }).waitFor();
  await debug.getByText(modal.id, {
    exact: false
  }).first().waitFor();
  assert.equal((await client.callTool({
    name: "runner_click",
    arguments: {
      selector: "#submit"
    }
  })).isError, true);
  assert.equal(count, 1);
  await call("runner_dialog", {
    action: "respond",
    id: modal.id,
    confirm: true,
    content: "AI回复"
  });
  await wait({
    kind: "text",
    text: "modal:AI回复"
  });
  await until(async () => !(await call("runner_status")).pendingDialogs?.some(d => d.id === modal.id));
  await debug.getByRole("button", {
    name: "刷新",
    exact: true
  }).click();
  await debug.getByText("等待 1 个对话框回复（showModal）", {
    exact: false
  }).waitFor({
    state: "hidden"
  });
  assert.equal((await client.callTool({
    name: "runner_dialog",
    arguments: {
      action: "respond",
      id: modal.id,
      confirm: true
    }
  })).isError, true);
  await call("runner_click", {
    selector: "#sheet"
  });
  const sheet = await wait({
    kind: "dialog",
    dialogType: "showActionSheet"
  });
  const invalid = await client.callTool({
    name: "runner_dialog",
    arguments: {
      action: "respond",
      id: sheet.id,
      tapIndex: 9
    }
  });
  assert.equal(invalid.isError, true);
  assert.ok((await call("runner_dialog")).some(d => d.id === sheet.id));
  await call("runner_dialog", {
    action: "respond",
    id: sheet.id,
    tapIndex: 1
  });
  await wait({
    kind: "text",
    text: "sheet:1"
  });
  const file = path.join(isolated.directory, "测试.txt");
  fs.writeFileSync(file, "file chooser fixture");
  await call("runner_click", {
    selector: "#files"
  });
  const picker = await wait({
    kind: "dialog",
    dialogType: "chooseMessageFile"
  });
  await call("runner_dialog", {
    action: "respond",
    id: picker.id,
    files: [file]
  });
  await wait({
    kind: "text",
    text: "file:测试.txt"
  });
  const timeout = await call("runner_wait", {
    kind: "text",
    text: "never-exists",
    timeoutMs: 80
  });
  assert.equal(timeout.status, "timeout");
  const pending = call("runner_wait", {
    kind: "text",
    text: "never-exists",
    waitId: "cancel-probe",
    timeoutMs: 10000
  });
  // list round-trip observes registration without a fixed sleep.
  for (let n = 0; n < 100; n++) if ((await call("runner_wait", {
    action: "list"
  })).some(w => w.waitId === "cancel-probe")) break;
  await call("runner_wait", {
    action: "cancel",
    waitId: "cancel-probe"
  });
  assert.equal((await pending).status, "cancelled");
  await call("runner_gesture", {
    action: "longpress",
    selector: "#gesture",
    durationMs: 750
  });
  await wait({
    kind: "state",
    instanceId,
    path: ["held"],
    equals: 1
  });
  const targetId = (await call("runner_status")).targets.find(t => t.kind === "view").targetId;
  const readView = async expression => {
    const r = await call("runner_evaluate", {
      targetId,
      expression
    });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  const view = {
    evaluate: fn => readView(`(${fn.toString()})()`),
    locator: selector => ({
      inputValue: () => readView(`document.querySelector(${JSON.stringify(selector)}).value`),
      evaluate: fn => readView(`(${fn.toString()})(document.querySelector(${JSON.stringify(selector)}))`)
    })
  };
  await view.evaluate(() => {
    globalThis.gestureAudit = [];
    globalThis.debugValidationErrors = 0;
    window.addEventListener("error", () => globalThis.debugValidationErrors++);
    document.addEventListener("dblclick", e => globalThis.gestureAudit.push({
      type: e.type,
      trusted: e.isTrusted
    }));
  });
  await call("runner_gesture", {
    action: "doubleclick",
    selector: "#gesture"
  });
  assert.ok(await view.evaluate(() => globalThis.gestureAudit.some(e => e.type === "dblclick" && e.trusted)));
  for (const args of [{
    x: 999999,
    y: 1
  }, {
    selector: "wx-button"
  }, {
    selector: "textarea",
    x: 1,
    y: 1
  }]) assert.equal((await client.callTool({
    name: "runner_click",
    arguments: args
  })).isError, true);
  const textBefore = await view.locator("textarea").inputValue();
  await view.locator("textarea").evaluate(el => el.readOnly = true);
  assert.equal((await client.callTool({
    name: "runner_input",
    arguments: {
      selector: "textarea",
      text: "must not be inserted"
    }
  })).isError, true);
  assert.equal(await view.locator("textarea").inputValue(), textBefore);
  await view.locator("textarea").evaluate(el => el.readOnly = false);
  assert.equal(await view.evaluate(() => globalThis.debugValidationErrors), 0);
  const rect = (await call("runner_dom", {
    selector: "#gesture"
  })).rect;
  for (const action of ["swipe", "drag"]) {
    await call("runner_gesture", {
      action,
      selector: "#gesture",
      endX: rect.x + rect.width / 2 + 50,
      endY: rect.y + rect.height / 2 - 20,
      durationMs: 250
    });
    await wait({
      kind: "text",
      text: "moved:"
    });
  }
  assert.ok((await call("runner_state", {
    action: "get",
    instanceId
  })).instances[0].data.moved > 0);
  await call("runner_gesture", {
    action: "keys",
    selector: "textarea",
    keys: ["Cmd", "A"]
  });
  await call("runner_gesture", {
    action: "keys",
    keys: ["Backspace"]
  });
  await wait({
    kind: "state",
    instanceId,
    path: ["input"],
    equals: ""
  });
  await call("runner_gesture", {
    action: "scroll",
    deltaY: 1000
  });
  await wait({
    kind: "element",
    selector: "#bottom"
  });
  await call("runner_gesture", {
    action: "scroll",
    deltaY: -2000
  });
  await wait({
    kind: "element",
    selector: "textarea"
  });
  await call("runner_evaluate", {
    expression: "wx.showLoading({title:'遮罩等待',mask:true});true"
  });
  await wait({
    kind: "element",
    selector: "[role=status]"
  });
  const covered = await client.callTool({
    name: "runner_click",
    arguments: {
      selector: "#gesture"
    }
  });
  assert.equal(covered.isError, true);
  await call("runner_evaluate", {
    expression: "wx.hideLoading();true"
  });
  await wait({
    kind: "hidden",
    selector: "[role=status]"
  });
  const abortController = new AbortController();
  const aborted = client.callTool({
    name: "runner_wait",
    arguments: {
      waitId: "transport-cancel",
      kind: "text",
      text: "unreachable"
    }
  }, undefined, {
    signal: abortController.signal,
    timeout: 65000
  }).catch(e => e);
  for (let n = 0; n < 100; n++) if ((await call("runner_wait", {
    action: "list"
  })).some(w => w.waitId === "transport-cancel")) break;
  abortController.abort();
  await aborted;
  for (let n = 0; n < 100; n++) if (!(await call("runner_wait", {
    action: "list"
  })).some(w => w.waitId === "transport-cancel")) break;
  assert.ok(!(await call("runner_wait", {
    action: "list"
  })).some(w => w.waitId === "transport-cancel"));
  await call("runner_click", {
    selector: "#sheet"
  });
  const cancelledSheet = await wait({
    kind: "dialog",
    dialogType: "showActionSheet"
  });
  await call("runner_dialog", {
    action: "respond",
    id: cancelledSheet.id,
    cancel: true
  });
  await wait({
    kind: "text",
    text: "sheet:cancel"
  });
  await call("runner_click", {
    selector: "#files"
  });
  const cancelledFile = await wait({
    kind: "dialog",
    dialogType: "chooseMessageFile"
  });
  const badFile = path.join(isolated.directory, "wrong.bin");
  fs.writeFileSync(badFile, "wrong extension");
  assert.equal((await client.callTool({
    name: "runner_dialog",
    arguments: {
      action: "respond",
      id: cancelledFile.id,
      files: [badFile]
    }
  })).isError, true);
  await call("runner_dialog", {
    action: "respond",
    id: cancelledFile.id,
    cancel: true
  });
  await wait({
    kind: "text",
    text: "file:cancel"
  });
  await call("runner_click", {
    selector: "#next"
  });
  await wait({
    kind: "route",
    route: "next"
  });
  await wait({
    kind: "text",
    text: "Next page"
  });
  const closedWait = call("runner_wait", {
    kind: "text",
    text: "never on next",
    waitId: "close-view"
  }).catch(e => e);
  for (let n = 0; n < 100; n++) if ((await call("runner_wait", {
    action: "list"
  })).some(w => w.waitId === "close-view")) break;
  await call("runner_navigate", {
    method: "navigateBack"
  });
  assert.ok((await closedWait) instanceof Error);
  await wait({
    kind: "route",
    route: "home"
  });
  assert.equal(logs.join("").split("modal-complete").length - 1, 1);
  assert.equal(logs.join("").split("sheet-complete").length - 1, 2);
  assert.equal(logs.join("").split("file-complete").length - 1, 2);
  const result = {
    date: new Date().toISOString(),
    passed: ["standard MCP input → real handler → wx.request → gzip Chinese response → setData → rendered result", "native Wxapp panel coexists with MCP", "pending dialog status shared with native Wxapp loading panel, removed after original callback", "native systemLog preserves original logic/view batch messages, Unicode and line breaks", "public scoped component query and explicit debug setData update", "modal, action sheet and file chooser callbacks complete once", "fast request matched from pre-action cursor", "condition waits, timeout, cancellation, route changes", "native longpress, swipe, drag, doubleclick, scrolling and key chords", "visible/hidden overlay checks, transport cancellation and closed-page waits", "invalid file type and repeated dialog responses rejected without callbacks"],
    requests: count
  };
  fs.writeFileSync("docs/interaction-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  try {
    console.log("DEBUGSNAP", JSON.stringify(await call("runner_snapshot")));
    console.log("DEBUGSTATE", JSON.stringify(await call("runner_state")));
  } catch {}
  throw e;
} finally {
  fs.writeFileSync(".local/interactions.log", logs.join(""));
  await client.close();
  await app.close();
  await new Promise(r => server.close(r));
  isolated.cleanup();
}

import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const t = await managedFixture({
  packageDir: path.resolve("../package"),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
});
try {
  const {
    call
  } = t;
  const clickText = async text => {
    await call("runner_wait", {
      kind: "text",
      text
    });
    const node = (await call("runner_snapshot")).elements.find(e => e.text === text);
    assert.ok(node, text);
    await call("runner_wait", {
      kind: "element",
      nodeId: node.nodeId,
      stableMs: 500
    });
    return call("runner_click", {
      nodeId: node.nodeId
    });
  };
  await call("runner_wait", {
    kind: "text",
    text: "一键提取视频"
  });
  const initial = await call("runner_status");
  assert.notEqual(initial.pid, t.app.process().pid);
  const config = JSON.parse(fs.readFileSync("../package/app-config.json", "utf8"));
  const missing = config.pages.filter(p => !fs.existsSync(path.join("../package", p + ".html")));
  assert.equal(missing.length, 28);
  const rejected = await t.client.callTool({
    name: "runner_navigate",
    arguments: {
      method: "navigateTo",
      url: "/" + missing[0]
    }
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /PAGE_FILE_MISSING/);
  assert.equal((await call("runner_status")).current.route, initial.current.route);
  await clickText("智能创作");
  await call("runner_wait", {
    kind: "text",
    text: "文生视频"
  });
  await call("runner_wait", {
    kind: "element",
    selector: "textarea",
    stableMs: 500
  });
  await call("runner_input", {
    selector: "textarea",
    text: "保留输入状态"
  });
  await clickText("热门工具");
  await call("runner_wait", {
    kind: "text",
    text: "一键抠图"
  });
  await clickText("一键抠图");
  await call("runner_wait", {
    kind: "text",
    text: "点击选择要抠图的图片"
  });
  const toolStatus = await call("runner_status");
  const closedTarget = toolStatus.targets.find(x => x.kind === "view" && !initial.targets.some(y => y.targetId === x.targetId))?.targetId;
  assert.ok(closedTarget);
  await call("runner_navigate", {
    method: "navigateBack"
  });
  await call("runner_wait", {
    kind: "text",
    text: "一键提取视频"
  });
  await until(async () => !(await call("runner_status")).targets.some(x => x.targetId === closedTarget));
  const stale = await t.client.callTool({
    name: "runner_debugger",
    arguments: {
      action: "state",
      targetId: closedTarget
    }
  });
  assert.equal(stale.isError, true);
  const input = await call("runner_dom", {
    selector: "textarea"
  });
  assert.ok(JSON.stringify(input).includes("保留输入状态"));
  const events = await call("runner_state", {
    action: "events",
    limit: 200
  });
  assert.ok(events.entries.some(e => e.type === "setData" && e.context?.rootHandler === "selectToolCategory"));
  const image = await t.client.callTool({
    name: "runner_screenshot",
    arguments: {
      fullPage: true
    }
  });
  assert.ok(!image.isError, JSON.stringify(image));
  fs.writeFileSync("docs/managed-home.png", Buffer.from(image.content.find(x => x.type === "image").data, "base64"));
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    realMainPackage: true,
    realClickHandlerAndSetData: true,
    navigationStateRetention: true,
    missing28SubpackagePagesFailBeforeNavigation: true,
    closedTargetRemoved: true,
    accountConfigurationUsed: false
  };
  fs.writeFileSync("docs/managed-original-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(t.logs.join("").slice(-3000));
  throw e;
} finally {
  await t.close();
}

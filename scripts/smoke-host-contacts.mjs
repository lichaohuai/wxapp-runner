import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";

// Every identity/domain/signature in this fixture is synthetic and loopback
// only. No real package, account, verification service or consent is changed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-contact-smoke-"));
const appid = process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  provider = process.env.WXAPP_TEST_APPID_2 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_2 to the AppID for your authorized test package");
  })();
const verifies = [],
  business = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const b of req) raw += b;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader("content-type", "application/json");
  if (req.url === "/miniprogram/verifyplugin") {
    verifies.push(JSON.parse(body.data));
    res.end(JSON.stringify({
      ok: true,
      ret: 0,
      json: JSON.stringify({
        list: [{
          plugin_id: provider,
          banning: 0,
          running_flag_info: 0,
          request_domain: [base],
          upload_domain: [base],
          download_domain: [base],
          wsrequest_domain: [],
          host_sign: "local-fixture-only",
          noncestr: "fixture",
          timestamp: "1"
        }]
      })
    }));
  } else if (req.url === "/business") {
    business.push({
      body,
      pluginHostSign: !!req.headers["x-wechat-hostsign"]
    });
    res.end(JSON.stringify({
      message: "插件结果:" + body.message
    }));
  } else res.writeHead(404).end('{"ok":false}');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const pkg = interactionFixture(dir, base + "/business");
const config = JSON.parse(fs.readFileSync(path.join(pkg, "app-config.json"), "utf8"));
config.appVersion = 8;
config.plugins = {
  example: {
    provider,
    version: "1.2.3",
    subpackage: "__APP__"
  }
};
fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify(config));
fs.writeFileSync(path.join(pkg, "app-service.js"), `
definePlugin('plugin://${provider}',function(define,require,module,exports,global,wx){
  define('index.js',function(require,module,exports){module.exports={run:message=>new Promise((resolve,reject)=>wx.request({url:${JSON.stringify(base + "/business")},method:'POST',data:{message},success:r=>resolve(r.data),fail:reject}))};});
  module.exports=()=>require('index.js');
});
App({});__wxRoute='home';__wxRouteBegin=true;__wxAppCurrentFile__='home.js';
Page({data:{input:'',result:''},onInput(e){this.setData({input:e.detail.value})},submit(){requirePlugin('example').run(this.data.input).then(r=>this.setData({result:r.message}),e=>this.setData({result:e.errMsg}))}});
__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({});`);
const contactsFile = path.join(dir, "contacts.json");
const contact = {
  format: 1,
  appid,
  appVersion: 8,
  capturedAt: new Date().toISOString(),
  appContactInfo: {
    call_plugin_info: [{
      plugin_id: provider,
      inner_version: 73,
      plugin_version: 0
    }]
  },
  contactList: [{
    appId: provider,
    plugin_list: [{
      PluginNetWork: {
        RequestDomain: [base],
        UploadDomain: [base],
        DownloadDomain: [base],
        WsRequestDomain: [],
        TCPDomain: []
      },
      last_version: {
        custom_version: "1.2.3"
      }
    }]
  }]
};
fs.writeFileSync(contactsFile, JSON.stringify(contact));
let t;
try {
  t = await managedFixture({
    packageDir: pkg,
    appid,
    config: {
      contactsFile,
      wxbot: base,
      deviceId: "local-only",
      loaderAdapter: "official",
      analysis: {
        enabled: false,
        networkMode: "local-only"
      }
    }
  });
  const {
    call
  } = t;
  const boot = await until(async () => {
    const s = await call("runner_status");
    return s.loader?.pluginContacts?.batchCalls > 0 && s.loader?.pluginVerification?.state === "response-received" && s;
  });
  assert.equal(boot.loader.pluginContacts.state, "loaded");
  assert.deepEqual(boot.loader.pluginContacts.missingContacts, []);
  assert.ok(!boot.loader.nativeBoundary.entries.some(e => e.api === "batchGetContact"));
  assert.ok(verifies.length > 0);
  assert.equal(verifies[0].plugins[0].inner_version, 73);
  const contextId = (await call("runner_debugger", {
    action: "state",
    limit: 1
  })).contexts.find(c => c.name === "WeChat service base library").id;
  const evaluate = async expression => {
    const r = await call("runner_evaluate", {
      contextId,
      expression,
      awaitPromise: true
    });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  assert.equal(await evaluate("__wxConfig.appContactInfo.call_plugin_info[0].inner_version"), 73);
  // The release main context deliberately does not export Bridge.invoke.
  // Use the existing business debugger's original SDK internals instead.
  assert.equal(boot.loader.pluginContacts.lastError, undefined);
  const native = async ids => {
    const r = await call("runner_evaluate", {
      expression: `new Promise(resolve=>internals.WeixinJSBridge.invoke('batchGetContact',{appIds:${JSON.stringify(ids)}},resolve))`,
      awaitPromise: true
    });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  assert.deepEqual((await native([provider])).contactList, contact.contactList);
  assert.deepEqual((await native([provider])).contactList, contact.contactList);
  assert.equal((await native([process.env.WXAPP_TEST_APPID_3 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_3 to the AppID for your authorized test package");
  })()])).runnerCode, "HOST_CONTACTS_MISSING");
  await native([provider]);
  assert.equal((await call("runner_wait", {
    kind: "element",
    selector: "textarea"
  })).status, "matched");
  await call("runner_input", {
    selector: "textarea",
    text: "中文输入🙂"
  });
  const cursor = (await call("runner_status")).networkCursor;
  await call("runner_click", {
    text: "提交",
    exact: true
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "插件结果:中文输入🙂",
    timeoutMs: 10000
  })).status, "matched");
  assert.equal(business.length, 1, "One click must create one plugin request");
  assert.equal(business[0].pluginHostSign, true, "The original plugin SDK must add its header");
  const network = await call("runner_network", {
    after: cursor,
    filter: {
      urlIncludes: "/business"
    },
    summary: true
  });
  assert.equal(network.entries.length, 1);
  await call("runner_debugger", {
    action: "open"
  });
  const debug = await until(() => t.app.windows().find(p => p.url().includes("js_app.html")));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  await debug.getByRole("combobox", {
    name: "Wxapp section"
  }).selectOption({
    label: "加载链路"
  });
  await debug.getByText("插件启动数据与校验", {
    exact: true
  }).waitFor();
  await debug.getByText('"inner_version": 73', {
    exact: false
  }).first().waitFor();
  await debug.getByText('"bootSource": "host-snapshot"', {
    exact: false
  }).first().waitFor();
  await debug.getByText("插件启动数据与校验", {
    exact: true
  }).scrollIntoViewIfNeeded();
  fs.mkdirSync(".local/plugin-contact-fix", {
    recursive: true
  });
  await debug.screenshot({
    path: ".local/plugin-contact-fix/contact-panel.png"
  });
  await debug.close();
  const before = await call("runner_status");
  fs.writeFileSync(contactsFile, JSON.stringify({
    ...contact,
    appid: process.env.WXAPP_TEST_APPID_3 || (() => {
      throw new Error("Set WXAPP_TEST_APPID_3 to the AppID for your authorized test package");
    })()
  }));
  const rejected = await t.client.callTool({
    name: "runner_runtime",
    arguments: {
      action: "restart"
    }
  });
  assert.ok(rejected.isError);
  assert.match(JSON.stringify(rejected), /HOST_CONTACTS_IDENTITY_MISMATCH/);
  const after = await call("runner_status");
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.serviceReady, true);
  contact.appContactInfo.call_plugin_info[0].inner_version = 74;
  fs.writeFileSync(contactsFile, JSON.stringify(contact));
  await call("runner_runtime", {
    action: "restart"
  });
  await until(async () => {
    const s = await call("runner_status");
    return s.sessionId !== before.sessionId && s.serviceReady && s.loader?.pluginVerification?.state === "response-received";
  });
  assert.equal(verifies.at(-1).plugins[0].inner_version, 74);
  assert.equal(business.length, 1, "Restart must not replay the business operation");
  console.log(JSON.stringify({
    status: "passed",
    framework: "real exparser",
    account: "synthetic-local-only",
    checks: ["boot metadata before plugin initialization", "native version 73", "original SDK batchGetContact initialization", "native callback repeated read and explicit missing ID", "native F12 Wxapp host metadata agrees with MCP", "MCP input/click → plugin wx.request → setData/DOM", "original SDK host header", "invalid restart preserves session", "explicit restart reads version 74 without replay"],
    businessRequests: business.length
  }));
} finally {
  if (t) await t.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, {
    recursive: true,
    force: true
  });
}

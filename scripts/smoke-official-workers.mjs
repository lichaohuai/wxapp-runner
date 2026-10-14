import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
const seen = [],
  connections = new Set();
let pendingResponse,
  pendingAborted = false;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const b of req) body += b;
  seen.push({ path: req.url, method: req.method, body });
  if (req.url === "/pending") {
    pendingResponse = res;
    res.on("close", () => {
      pendingAborted = !res.writableEnded;
    });
    return;
  }
  if (req.url.startsWith("/download")) {
    res.end("文件中文🙂");
    return;
  }
  const delay = req.url.includes("alpha") ? 120 : 0;
  setTimeout(() => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ path: req.url, body }));
  }, delay);
});
server.on("connection", (s) => {
  connections.add(s);
  s.on("close", () => connections.delete(s));
});
const ws = new WebSocketServer({ server });
ws.on("connection", (c) =>
  c.on("message", (data, binary) => c.send(data, { binary })),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
let fixture;
try {
  fixture = await managedFixture({
    debug: {nativeContractCalls:true},
    beforeStart({ packageDir }) {
      const file = path.join(packageDir, "app-config.json"),
        conf = JSON.parse(fs.readFileSync(file));
      conf.workers = "workers";
      conf.wxAppInfo = { maxWorkerConcurrent: 2 };
      fs.writeFileSync(file, JSON.stringify(conf));
      const factory = `function(require,module,exports){globalThis.__workerFixture=true;
   worker.onMessage(function(m){
    if(m.command==='binary'){const bytes=new Uint8Array(m.payload);worker.postMessage({kind:'binary',label:m.label,valid:m.payload instanceof ArrayBuffer,bytes:Array.from(bytes)});return;}
    if(m.command==='pending'){worker.request({url:m.url+'/pending',success:function(){worker.postMessage({kind:'late'});}});return;}
    if(m.command==='files'){const fm=worker.getFileSystemManager();fm.writeFile({filePath:'wxfile://usr/worker-'+m.label,data:'Worker文件🙂',encoding:'utf8',success:function(){fm.readFile({filePath:'wxfile://usr/worker-'+m.label,encoding:'utf8',success:function(r){worker.postMessage({kind:'files',label:m.label,data:r.data});},fail:function(e){worker.postMessage({kind:'error',error:e});}});},fail:function(e){worker.postMessage({kind:'error',error:e});}});return;}
    if(m.command==='close'){worker.postMessage({kind:'closing',label:m.label});return;}
    worker.request({url:m.url+'/echo?'+m.label,method:'POST',data:JSON.stringify({label:m.label,text:'中文🙂'}),header:{'content-type':'application/json'},
     success:function(r){worker.postMessage({kind:'response',label:m.label,data:r.data,hasDom:typeof document,hasNode:typeof process});},fail:function(e){worker.postMessage({kind:'error',error:e});}});
    if(m.label==='alpha'){
     var s=worker.connectSocket({url:m.url.replace('http:','ws:')+'/socket'});
     s.onOpen(function(){s.send({data:'Worker中文🙂'});});
     s.onMessage(function(r){worker.postMessage({kind:'socket',data:r.data});s.close({code:3001});});
     s.onError(function(e){worker.postMessage({kind:'error',error:e});});
     worker.downloadFile({url:m.url+'/download',success:function(r){worker.uploadFile({url:m.url+'/upload',filePath:r.tempFilePath,name:'sample',success:function(u){worker.postMessage({kind:'upload',status:u.statusCode});},fail:function(e){worker.postMessage({kind:'error',error:e});}});},fail:function(e){worker.postMessage({kind:'error',error:e});}});
    }
   });
  }`;
      fs.writeFileSync(
        path.join(packageDir, "workers.js"),
        `define('workers/alpha.js',${factory});define('workers/beta.js',${factory});`,
      );
      const p = path.join(packageDir, "app-service.js");
      let s = fs.readFileSync(p, "utf8");
      const a = s.indexOf(" submit(){"),
        b = s.indexOf("\n modal(){", a);
      assert.ok(a > 0 && b > a);
      const handler = ` submit(){globalThis.__workerResults=[];globalThis.__testWorkers=[];const page=this;
   for(const label of ['alpha','beta']){const w=wx.createWorker('workers/'+label+'.js');__testWorkers.push(w);
    w.onMessage(r=>{__workerResults.push(r);if(__workerResults.filter(x=>x.kind==='response').length===2 && __workerResults.some(x=>x.kind==='socket') && __workerResults.some(x=>x.kind==='upload'))page.setData({result:'两个Worker完成中文网络与文件🙂'});});
    w.postMessage({label,url:${JSON.stringify(url)}});}},`;
      fs.writeFileSync(p, s.slice(0, a) + handler + s.slice(b));
    },
  });
  const call = fixture.call;
  const evaluate = async (expression, targetId) => {
    const r = await call("runner_evaluate", { expression, targetId });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  assert.equal((await call("runner_wait", { kind: "element", selector: "#submit" })).status, "matched");
  await call("runner_click", { text: "提交", exact: true });
  try {
    assert.equal(
      (
        await call("runner_wait", {
          kind: "text",
          text: "两个Worker完成中文网络与文件🙂",
          timeoutMs: 15000,
        })
      ).status,
      "matched",
    );
  } catch (error) {
    console.error(JSON.stringify(await evaluate("__workerResults")));
    console.error(fixture.logs.join("").slice(-12000));
    throw error;
  }
  const result = await evaluate("__workerResults");
  assert.equal(result.filter((r) => r.kind === "response").length, 2);
  for (const r of result.filter((r) => r.kind === "response")) {
    assert.equal(JSON.parse(r.data.body).label, r.label);
    assert.equal(r.hasDom, "undefined");
    assert.equal(r.hasNode, "undefined");
  }
  assert.equal(result.find((r) => r.kind === "socket").data, "Worker中文🙂");
  assert.equal(seen.filter((r) => r.path.startsWith("/echo")).length, 2);
  assert.ok(seen.find((r) => r.path === "/upload").body.includes("文件中文🙂"));
  await evaluate(`__testWorkers.forEach((w,i)=>w.postMessage({command:'binary',label:String(i),payload:new Uint8Array([0,127,128,255]).buffer}));true`);
  await until(async () => (await evaluate('__workerResults.filter(r=>r.kind==="binary").length')) === 2);
  for (const r of await evaluate('__workerResults.filter(r=>r.kind==="binary")')) {
    assert.equal(r.valid, true, "original WAWorker must reconstruct a realm-local ArrayBuffer");
    assert.deepEqual(r.bytes, [0,127,128,255]);
  }
  const runtime = (await call("runner_runtime", { action: "list" }))
    .runtimes[0];
  const targets = runtime.targets.filter((t) => t.kind === "worker");
  assert.ok(targets.length >= 2);
  const business = [];
  for (const t of targets) {
    try {
      if (await evaluate("globalThis.__workerFixture === true", t.targetId))
        business.push(t);
    } catch {}
  }
  assert.equal(business.length, 2);
  for (const target of business) {
    assert.equal(
      await evaluate('typeof process + "/" + typeof document', target.targetId),
      "undefined/undefined",
    );
    assert.equal(
      (
        await call("runner_debugger", {
          action: "capabilities",
          targetId: target.targetId,
        })
      ).trace,
      false,
    );
  }
  const records = (
    await call("runner_network", { filter: { urlIncludes: url }, limit: 100 })
  ).entries;
  assert.equal(records.filter((r) => r.url.includes("/echo")).length, 2);
  assert.ok(
    records
      .filter((r) => r.url.includes("/echo"))
      .every((r) => r.context?.workerId || r.targetId?.startsWith("worker:")),
  );
  await evaluate(
    `__testWorkers.forEach((w,i)=>w.postMessage({command:'files',label:String(i)}));true`,
  );
  await until(
    async () =>
      (await evaluate('__workerResults.filter(r=>r.kind==="files").length')) ===
      2,
  );
  assert.ok(
    (await evaluate('__workerResults.filter(r=>r.kind==="files")')).every(
      (r) => r.data === "Worker文件🙂",
    ),
  );
  await call("runner_debugger", {
    action: "open",
    targetId: business[0].targetId,
  });
  const devtools = await until(() =>
    fixture.app.windows().find((p) => p.url().includes("/js_app.html")),
  );
  await devtools.getByRole("tab", { name: "Console", exact: true }).click();
  await evaluate(
    'console.log("worker-native-console-check");true',
    business[0].targetId,
  );
  await devtools
    .getByText("worker-native-console-check", { exact: false })
    .first()
    .waitFor();
  await devtools.screenshot({ path: "docs/official-worker-devtools.png" });
  await devtools.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await devtools
    .getByLabel("Wxapp section")
    .selectOption({ label: "加载链路" });
  await devtools.getByText("逻辑上下文", { exact: true }).waitFor();
  await devtools.getByText("Worker 与 H5 调试目标", { exact: true }).waitFor();
  await devtools.screenshot({ path: "docs/official-loader-panel.png" });
  await evaluate(
    `__testWorkers[0].postMessage({command:'pending',url:${JSON.stringify(url)}});true`,
  );
  await until(() => !!pendingResponse);
  const countBeforeTerminate = await evaluate("__workerResults.length");
  await evaluate("__testWorkers.forEach(w=>w.terminate());true");
  await until(async () => {
    const active = (await call("runner_runtime", { action: "list" }))
      .runtimes[0].targets;
    return business.every(
      (t) => !active.some((a) => a.targetId === t.targetId),
    );
  });
  await until(() => pendingAborted);
  assert.equal(await evaluate("__workerResults.length"), countBeforeTerminate);
  const stale = await fixture.client.callTool({
    name: "runner_evaluate",
    arguments: { targetId: business[0].targetId, expression: "1" },
  });
  assert.ok(stale.isError);
  const observations=await until(async()=>{
    const entries=(await call("runner_status")).loader.nativeContracts.entries;
    return entries.some(e=>e.layer==="worker"&&e.phases["callback-delivered"]) && entries;
  });
  const workerIds=new Set(observations.filter(e=>e.layer==="worker").map(e=>e.context.workerId));
  assert.ok(workerIds.size>=2,"Observed calls retain distinct Worker identity");
  assert.ok(observations.filter(e=>e.layer==="worker").every(e=>e.contractId.startsWith("native:worker:invoke:")));
  const report = {
    observedNativeIds: [...new Set(observations.filter(e=>e.layer==="worker"&&e.phases.invoked).map(e=>e.contractId))],
    nativeContractWorkerIdentity: true,
    passed: true,
    platform: process.platform,
    officialWorkerClient: true,
    concurrentWorkers: 2,
    isolatedRealms: true,
    requestCallbacks: true,
    socket: true,
    downloadUpload: true,
    mcpWorkerTargets: true,
    nativeDevtoolsOpened: true,
    nativeConsoleVisible: true,
    asyncFilesystem: true,
    binaryMessagesViaOriginalSDK: true,
    inflightAbortOnTerminate: true,
    noLateCallback: true,
    terminatedTargetInvalid: true,
    requestCount: seen.length,
  };
  fs.writeFileSync(
    "docs/official-workers-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  if (fixture) await fixture.close();
  for (const c of ws.clients) c.terminate();
  ws.close();
  for (const c of connections) c.destroy();
  await new Promise((r) => server.close(r));
}

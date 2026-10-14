import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleInventory, buildCatalog } from "../src/suite/catalog";
import { SuiteJobs } from "../src/suite/jobs";
import { setTimeout as delay } from "node:timers/promises";
test("catalog uses compiled module AST, ignores strings/comments, inventories all official routes without granting flow acceptance", () => {
  const modules = moduleInventory(`define('page/a.js',function(){Page({tap(){wx.cloud.callFunction({name:'test'})}});const text='wx.fake()';/*wx.alsoFake()*/})`);
  assert.deepEqual(modules.get("page/a")?.apis, ["wx.cloud.callFunction"]);
  assert.deepEqual(modules.get("page/a")?.handlers, ["tap"]);
  const catalog = buildCatalog({
    packageDir: "../package-" + ("wx" + "000000000000000f"),
    baselibDir: "../baselib"
  });
  assert.equal(catalog.pageCount, 356);
  assert.equal(catalog.scanErrors.length, 0);
  assert.ok(catalog.pages.every(p => p.apiInventory.file && p.acceptance.flow === null && p.acceptance.status === "已实现未验收"));
});
test("suite validates all operations before navigation, treats assertion timeout as failure and never resubmits input", async () => {
  const suites = new SuiteJobs();
  let calls: string[] = [];
  const options = {
    runtimeId: "r",
    sessionId: "s",
    clientId: "c",
    routes: ["page/a"],
    availableRoutes: ["page/a"],
    steps: [],
    timeoutMs: 10,
    check: () => {},
    emit: () => {},
    call: async (name: string) => {
      calls.push(name);
      if (name === "runner_wait") return {
        status: "timeout"
      };
      return {};
    }
  };
  assert.throws(() => suites.start({
    ...options,
    steps: [{
      tool: "runner_click",
      arguments: {
        x: 1
      }
    }]
  }));
  assert.equal(calls.length, 0);
  const job = suites.start(options);
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = suites.get(job.id, "r");
    if (result.state !== "running") break;
    await delay(1);
  }
  assert.equal(result.results[0].status, "失败");
  assert.equal(result.results[0].error.code, "SUITE_ASSERTION_TIMEOUT");
  assert.deepEqual(calls, ["runner_navigate", "runner_wait"]);
  suites.close();
});
test("analysis scenarios bind identities, invoke exactly once, preserve current page and clean only owned capture", async () => {
  const suites = new SuiteJobs(),
    calls: any[] = [];
  const options: any = {
    runtimeId: "r",
    sessionId: "s",
    clientId: "c",
    mode: "analysis",
    routes: [],
    availableRoutes: [],
    timeoutMs: 10,
    check() {},
    emit() {},
    async call(name: string, a: any) {
      calls.push({
        name,
        ...a
      });
      if (name === "runner_execution" && a.action === "start") return {
        runId: "own-run"
      };
      if (name === "runner_oracle" && a.action === "call") return {
        value: "result"
      };
      return {};
    },
    steps: [{
      tool: "runner_execution",
      arguments: {
        action: "start"
      },
      saveAs: "capture"
    }, {
      tool: "runner_oracle",
      arguments: {
        action: "call",
        oracleId: "existing"
      }
    }, {
      tool: "runner_execution",
      arguments: {
        action: "read"
      },
      bind: {
        runId: "capture.runId"
      }
    }]
  };
  const j = suites.start(options);
  while (suites.get(j.id, "r").state === "running") await delay(1);
  assert.equal(suites.get(j.id, "r").results[0].status, "验收通过");
  assert.equal(calls.filter(c => c.name === "runner_oracle").length, 1);
  assert.ok(!calls.some(c => c.name === "runner_navigate"));
  assert.equal(calls.find(c => c.action === "read").runId, "own-run");
  assert.equal(calls.at(-1).runId, "own-run");
  assert.equal(calls.at(-1).action, "stop");
  const before = calls.length;
  assert.throws(() => suites.start({
    ...options,
    steps: [...options.steps, {
      tool: "runner_oracle",
      arguments: {
        action: "call",
        oracleId: "existing"
      }
    }]
  }), /one explicit/);
  assert.throws(() => suites.start({
    ...options,
    steps: [{
      tool: "runner_execution",
      arguments: {
        action: "read"
      },
      bind: {
        runId: "missing.runId"
      }
    }]
  }), /binding/);
  assert.equal(calls.length, before);
});
test("cancelling while capture start reply is pending cleans that capture and never calls the oracle", async () => {
  const suites = new SuiteJobs(),
    calls: any[] = [];
  let started!: () => void, reply!: (v: any) => void;
  const pending = new Promise<any>(r => {
    reply = r;
  });
  const entered = new Promise<void>(r => {
    started = r;
  });
  const job = suites.start({
    runtimeId: "r",
    sessionId: "s",
    clientId: "c",
    mode: "analysis",
    routes: [],
    availableRoutes: [],
    timeoutMs: 100,
    check() {},
    emit() {},
    steps: [{
      tool: "runner_execution",
      arguments: {
        action: "start"
      }
    }, {
      tool: "runner_oracle",
      arguments: {
        action: "call",
        oracleId: "never"
      }
    }],
    async call(name, args) {
      calls.push({
        name,
        ...args
      });
      if (name === "runner_execution" && args.action === "start") {
        started();
        return pending;
      }
      return {};
    }
  });
  await entered;
  suites.cancel(job.id, "r", "c");
  reply({
    runId: "late-owned-run"
  });
  for (let i = 0; i < 100 && suites.get(job.id, "r").state === "running"; i++) await delay(1);
  assert.equal(suites.get(job.id, "r").state, "cancelled");
  assert.equal(calls.filter(c => c.name === "runner_oracle").length, 0);
  assert.equal(calls.filter(c => c.action === "stop").length, 1);
  assert.equal(calls.at(-1).runId, "late-owned-run");
});

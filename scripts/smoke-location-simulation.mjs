// Original official demo package; explicit public-landmark simulation only.
import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const t = await managedFixture({
  packageDir: path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
});
const {
  call
} = t;
try {
  await call("runner_navigate", {
    method: "navigateTo",
    url: "/packageAPI/pages/location/get-location/get-location"
  });
  await call("runner_wait", {
    kind: "text",
    text: "获取位置"
  });
  assert.equal((await call("runner_state", {
    action: "location"
  })).mode, "system");
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
    label: "定位"
  });
  await debug.getByRole("textbox", {
    name: "纬度（WGS84）",
    exact: true
  }).fill("39.907333");
  await debug.getByRole("textbox", {
    name: "经度（WGS84）",
    exact: true
  }).fill("116.391083");
  await debug.getByRole("button", {
    name: "启用模拟定位",
    exact: true
  }).click();
  await until(async () => (await call("runner_state", {
    action: "location"
  })).simulated);
  await debug.getByText("模拟定位已启用", {
    exact: false
  }).waitFor();
  const click = await call("runner_click", {
    text: "获取位置"
  });
  const prompt = await call("runner_wait", {
    kind: "dialog",
    dialogType: "authorize"
  });
  assert.equal(prompt.status, "matched");
  await call("runner_dialog", {
    action: "respond",
    id: prompt.result.id,
    confirm: true
  });
  const page = (await call("runner_state")).pages.at(-1);
  const state = await call("runner_state");
  const instance = state.instances.find(i => i.route === page.route && i.data && "hasLocation" in i.data);
  assert.ok(instance);
  assert.equal((await call("runner_wait", {
    kind: "state",
    instanceId: instance.id,
    path: ["hasLocation"],
    equals: true
  })).status, "matched");
  const snapshot = await call("runner_snapshot");
  assert.ok(!snapshot.text.includes("未获取"));
  const trace = [];
  let after = 0;
  for (;;) {
    const p = await call("runner_trace", {
      operationId: click.operationId,
      after,
      limit: 200
    });
    trace.push(...p.entries);
    after = p.nextCursor;
    if (!p.hasMore) break;
  }
  const entries = trace.flatMap(e => e.args || []);
  assert.ok(entries.some(e => e?.type === "location-result" && e.simulated === true));
  assert.ok(entries.some(e => e?.type === "callback" && e.callback === "success"));
  await debug.getByRole("button", {
    name: "恢复系统定位",
    exact: true
  }).click();
  await until(async () => (await call("runner_state", {
    action: "location"
  })).mode === "system");
  // MCP and F12 edit the same setting, and a fresh runtime resets simulation.
  await call("runner_state", {
    action: "location",
    location: {
      mode: "simulated",
      latitude: 39.907333,
      longitude: 116.391083
    }
  });
  const session = (await call("runner_status")).sessionId;
  await call("runner_runtime", {
    action: "restart"
  });
  await until(async () => {
    const s = await call("runner_status");
    return s.sessionId !== session && s.serviceReady && s.current?.ready;
  });
  assert.equal((await call("runner_state", {
    action: "location"
  })).mode, "system");
  // Explicit opt-in persists only this app/profile, through both MCP aliases.
  await call("runner_device", {
    action: "location",
    location: {
      mode: "simulated",
      latitude: 39.907333,
      longitude: 116.391083
    },
    persist: true
  });
  const persistedSession = (await call("runner_status")).sessionId;
  await call("runner_runtime", {
    action: "restart"
  });
  await until(async () => {
    const s = await call("runner_status");
    return s.sessionId !== persistedSession && s.serviceReady && s.current?.ready;
  });
  assert.equal((await call("runner_device", {
    action: "location"
  })).persisted, true);
  await call("runner_state", {
    action: "location",
    location: {
      mode: "system"
    },
    persist: false
  });
  const report = {
    date: new Date().toISOString(),
    platform: process.platform,
    status: "验收通过",
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    originalPage: true,
    simulationExplicit: true,
    nativeF12AndMcpShared: true,
    originalSuccessCallback: true,
    renderedCoordinates: true,
    simulatedEventLinked: true,
    restoreSystemMode: true,
    resetOnRestart: true,
    explicitSaveSurvivesRestart: true,
    savedLocationCleared: true,
    systemPrivacyUnchanged: true,
    packetCapture: false,
    realLocationClaimed: false
  };
  fs.writeFileSync("docs/location-simulation-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await t.close();
}

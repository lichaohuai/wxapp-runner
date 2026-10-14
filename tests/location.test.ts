import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocationService, locationOptions, locationResult } from "../src/location/service";
import { type LocationProvider, type LocationFix, locationError } from "../src/location/provider";
import { locationApis } from "../src/wx-shim/location";
import { debugContext, setDebugEmitter } from "../src/debug/context";
import { parseTool } from "../src/mcp/tools";
import { isRead } from "../src/controller/control";
const scope = "scope.userLocation";
const fix = (): LocationFix => ({
  latitude: 39.908823,
  longitude: 116.39747,
  accuracy: 25,
  timestamp: Date.now()
});
const simulated = {
  mode: "simulated",
  latitude: 39.907333,
  longitude: 116.391083,
  accuracy: 25
};
test("explicit simulation bypasses the OS provider, preserves app authorization, and restores system behavior", async t => {
  const f = fixture(t);
  let osCalls = 0;
  f.provider.locate = async () => {
    osCalls++;
    throw locationError("LOCATION_SERVICES_DISABLED", "system location services disabled");
  };
  assert.equal(f.service.debugLocation().mode, "system");
  await assert.rejects(f.service.getLocation({}), {
    runnerCode: "LOCATION_SERVICES_DISABLED"
  });
  assert.equal(f.service.debugLocation(simulated).simulated, true);
  const wx = locationApis((_, args) => f.service.getLocation(args));
  const callbacks: string[] = [];
  await wx.getLocation({
    success: (r: any) => {
      callbacks.push("success");
      assert.equal(r.latitude, simulated.latitude);
      assert.equal(r.longitude, simulated.longitude);
      assert.equal(r.errMsg, "getLocation:ok");
      assert.equal(r.simulated, undefined); // Debug metadata never changes wx response semantics.
    },
    fail: () => callbacks.push("fail"),
    complete: () => callbacks.push("complete")
  });
  assert.deepEqual(callbacks, ["success", "complete"]);
  assert.equal(osCalls, 1);
  assert.ok(f.events.some(e => e.type === "location-result" && e.simulated));
  const gcj = await f.service.getLocation({
    type: "gcj02"
  });
  assert.ok(Math.abs(gcj.longitude - 116.39732) < 0.0001);
  f.service.debugLocation({
    mode: "system"
  });
  await assert.rejects(f.service.getLocation({}), {
    runnerCode: "LOCATION_SERVICES_DISABLED"
  });
  assert.equal(osCalls, 2);
});
test("simulation supports a host without native location but never silently overrides app denial", async t => {
  const f = fixture(t, async () => ({
    confirm: false
  }));
  Object.assign(f.provider, {
    available: false
  });
  f.service.debugLocation(simulated);
  await assert.rejects(f.service.getLocation({}), {
    runnerCode: "LOCATION_APP_DENIED"
  });
  assert.equal(f.requests(), 0);
  const restarted = new LocationService(f.provider, f.filename, async () => ({}), "test", "");
  assert.equal(restarted.debugLocation().mode, "system");
  assert.equal(restarted.getSetting().authSetting[scope], false);
});
test("invalid simulation is rejected before side effects; changing mode cancels late native fixes", async t => {
  const f = fixture(t);
  await f.service.authorize({
    scope
  });
  let signal!: AbortSignal, resolve!: (v: LocationFix) => void;
  f.provider.locate = async (_, s) => {
    signal = s;
    return new Promise(r => {
      resolve = r;
    });
  };
  const pending = f.service.getLocation({});
  await Promise.resolve();
  for (const value of [{
    ...simulated,
    latitude: 91
  }, {
    ...simulated,
    longitude: NaN
  }, {
    ...simulated,
    accuracy: -1
  }, {
    mode: "simulated",
    latitude: 1
  }, {
    mode: "system",
    longitude: 0
  }]) assert.throws(() => f.service.debugLocation(value));
  assert.equal(signal.aborted, false);
  assert.equal(f.service.debugLocation().mode, "system");
  f.service.debugLocation(simulated);
  assert.equal(signal.aborted, true);
  resolve(fix());
  await assert.rejects(pending, {
    runnerCode: "LOCATION_CANCELLED"
  });
  assert.equal((await f.service.getLocation({})).latitude, simulated.latitude);
});
test("MCP location mutations use the write queue and reject malformed or misplaced overrides", () => {
  assert.equal(isRead("runner_state", parseTool("runner_state", {
    action: "location"
  })), true);
  for (const location of [simulated, {
    mode: "system"
  }]) {
    const args = parseTool("runner_state", {
      action: "location",
      location
    });
    assert.equal(isRead("runner_state", args), false);
  }
  assert.throws(() => parseTool("runner_state", {
    action: "list",
    location: simulated
  }));
  assert.throws(() => parseTool("runner_state", {
    action: "location",
    location: {
      mode: "simulated",
      latitude: 12
    }
  }));
  for (const name of ["runner_state", "runner_device"]) {
    assert.throws(() => parseTool(name, {
      action: "location",
      persist: true
    }));
    assert.throws(() => parseTool(name, {
      action: "get",
      persist: true
    }));
    const args = parseTool(name, {
      action: "location",
      location: simulated,
      persist: true
    });
    assert.equal((args as any).persist, true);
    assert.equal(isRead(name, args), false);
  }
});
test("saved debug location restores before calls, isolates app profiles and can be cleared", async t => {
  const f = fixture(t);
  f.service.debugLocation(simulated, true);
  assert.equal(f.service.debugLocation().lifetime, "app-profile");
  // Saving debug coordinates must not silently authorize the application.
  assert.equal(f.service.getSetting().authSetting[scope], undefined);
  const restart = () => new LocationService(f.provider, f.filename, async () => ({
    confirm: false
  }), "wx" + "0000000000000001", "");
  const saved = restart();
  assert.equal(saved.debugLocation().simulated, true);
  await assert.rejects(saved.getLocation({}), {
    runnerCode: "LOCATION_APP_DENIED"
  });
  const isolated = new LocationService(f.provider, path.join(f.dir, "other-profile/permissions.json"), async () => ({}), "wx" + "0000000000000001", "");
  assert.equal(isolated.debugLocation().mode, "system");
  const before = fs.readFileSync(path.join(path.dirname(f.filename), "debug-location.json"), "utf8");
  assert.throws(() => f.service.debugLocation({
    ...simulated,
    latitude: 100
  }, true));
  assert.equal(fs.readFileSync(path.join(path.dirname(f.filename), "debug-location.json"), "utf8"), before);
  assert.throws(() => new LocationService(f.provider, f.filename, async () => ({}), "wx" + "0000000000000006", ""), {
    runnerCode: "LOCATION_STORE_INVALID"
  });
  f.service.debugLocation({
    mode: "system"
  }, false);
  assert.equal(restart().debugLocation().mode, "system");
  assert.equal(restart().debugLocation().savedLocation, null);
});
function fixture(t: any, prompt: any = async () => ({
  confirm: true
})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-location-test-"));
  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));
  let requests = 0;
  const provider: LocationProvider = {
    name: "unit-test-only",
    available: true,
    status: async () => "authorized",
    locate: async () => {
      requests++;
      return fix();
    },
    close() {}
  };
  const events: any[] = [];
  const filename = path.join(dir, "apps/" + ("wx" + "0000000000000001") + "/permissions.json");
  const service = new LocationService(provider, filename, prompt, "wx" + "0000000000000001", "Location test", e => events.push(e));
  t.after(() => service.close());
  return {
    dir,
    filename,
    service,
    provider,
    events,
    requests: () => requests
  };
}
test("location validates options before prompting or requesting the host", async t => {
  let prompts = 0;
  const f = fixture(t, async () => {
    prompts++;
    return {
      confirm: true
    };
  });
  for (const options of [{
    type: "bd09"
  }, {
    altitude: 1
  }, {
    isHighAccuracy: "true"
  }, {
    highAccuracyExpireTime: -1
  }, {
    highAccuracyExpireTime: Infinity
  }, {
    highAccuracyExpireTime: 60001
  }]) await assert.rejects(f.service.getLocation(options), {
    runnerCode: "INVALID_ARGUMENT"
  });
  assert.equal(prompts, 0);
  assert.equal(f.requests(), 0);
  assert.deepEqual(f.service.getSetting(), {
    authSetting: {}
  });
  await assert.rejects(f.service.authorize({
    scope: "scope.camera"
  }), {
    runnerCode: "API_UNIMPLEMENTED"
  });
  assert.throws(() => f.service.getSetting({
    withSubscriptions: true
  }), {
    runnerCode: "API_UNIMPLEMENTED"
  });
});
test("app denial is persisted, isolated by profile, and does not automatically reprompt", async t => {
  let prompts = 0;
  const f = fixture(t, async () => {
    prompts++;
    return {
      confirm: false
    };
  });
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.getLocation({}), {
    runnerCode: "LOCATION_APP_DENIED"
  });
  assert.equal(prompts, 1);
  assert.equal(f.requests(), 0);
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
  const restored = new LocationService(f.provider, f.filename, async () => {
    throw Error("unexpected prompt");
  }, "test", "");
  assert.equal(restored.getSetting().authSetting[scope], false);
  await assert.rejects(restored.authorize({
    scope
  }), {
    runnerCode: "LOCATION_APP_DENIED"
  });
  const other = new LocationService(f.provider, path.join(f.dir, "different-profile/permissions.json"), async () => ({}), "test", "");
  assert.deepEqual(other.getSetting(), {
    authSetting: {}
  });
});
test("concurrent location calls share app authorization but preserve independent results", async t => {
  let accept: (v: any) => void = () => {},
    prompts = 0;
  const f = fixture(t, () => {
    prompts++;
    return new Promise(r => {
      accept = r;
    });
  });
  const a = f.service.getLocation({
      type: "wgs84"
    }),
    b = f.service.getLocation({
      type: "gcj02"
    });
  assert.equal(prompts, 1);
  accept({
    confirm: true
  });
  const [gps, gcj] = await Promise.all([a, b]);
  assert.equal(gps.longitude, fix().longitude);
  assert.ok(Math.abs(gcj.longitude - 116.403714) < 0.00001);
  assert.ok(Math.abs(gcj.latitude - 39.910226) < 0.00001);
  assert.equal(f.requests(), 2);
  assert.equal(gps.speed, undefined);
  assert.equal(gps.altitude, undefined);
  const outside = locationResult({
    ...fix(),
    longitude: -122.42,
    latitude: 37.77
  }, locationOptions({
    type: "gcj02"
  }));
  assert.equal(outside.longitude, -122.42);
  assert.equal(outside.latitude, 37.77);
});
test("setting changes use previously requested scopes; cancelling leaves permission intact", async t => {
  let response: any = {
    confirm: false
  };
  const f = fixture(t, async () => response);
  await assert.rejects(f.service.authorize({
    scope
  }));
  response = {
    authSetting: {
      [scope]: true
    }
  };
  assert.equal((await f.service.openSetting()).authSetting[scope], true);
  response = {
    cancel: true
  };
  assert.equal((await f.service.openSetting()).authSetting[scope], true);
  response = {
    authSetting: {
      "scope.camera": true
    }
  };
  await assert.rejects(f.service.openSetting(), {
    runnerCode: "INVALID_ARGUMENT"
  });
  assert.equal(f.service.getSetting().authSetting[scope], true);
  assert.equal(f.events.filter(e => e.type === "permission-change").length, 2);
});
test("OS denial remains distinguishable from mini-program permission and invokes failure/complete once", async t => {
  const f = fixture(t);
  f.provider.locate = async () => {
    throw locationError("LOCATION_SYSTEM_DENIED", "system location permission denied");
  };
  const wx = locationApis((name, args) => f.service.getLocation(args));
  const callbacks: any[] = [];
  await wx.getLocation({
    success: () => callbacks.push("unexpected"),
    fail: (e: any) => callbacks.push(e),
    complete: (e: any) => callbacks.push(e)
  });
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[0], callbacks[1]);
  assert.equal(callbacks[0].runnerCode, "LOCATION_SYSTEM_DENIED");
  assert.equal(f.service.getSetting().authSetting[scope], true);
});
test("closing a page or revoking authorization aborts its pending location and rejects late results", async t => {
  let response: any = {
    confirm: true
  };
  const f = fixture(t, async () => response);
  await f.service.authorize({
    scope
  });
  let resolveFix: (f: LocationFix) => void = () => {},
    signal!: AbortSignal;
  f.provider.locate = async (_, s) => {
    signal = s;
    return new Promise(r => {
      resolveFix = r;
    });
  };
  const first = f.service.getLocation({}, 12);
  await Promise.resolve();
  f.service.closeView(12);
  assert.equal(signal.aborted, true);
  resolveFix(fix());
  await assert.rejects(first, {
    runnerCode: "LOCATION_CANCELLED"
  });
  const second = f.service.getLocation({}, 13);
  await Promise.resolve();
  response = {
    authSetting: {
      [scope]: false
    }
  };
  await f.service.openSetting();
  assert.equal(signal.aborted, true);
  resolveFix(fix());
  await assert.rejects(second, {
    runnerCode: "LOCATION_CANCELLED"
  });
});
test("location data validation never substitutes fake coordinates or unknown speed/altitude", () => {
  for (const invalid of [{
    latitude: 91
  }, {
    longitude: 181
  }, {
    accuracy: -1
  }, {
    timestamp: 0
  }, {
    latitude: NaN
  }]) assert.throws(() => locationResult({
    ...fix(),
    ...invalid
  }, locationOptions()), {
    runnerCode: "LOCATION_INVALID_FIX"
  });
  const r = locationResult({
    ...fix(),
    altitude: 31,
    verticalAccuracy: 7,
    speed: 2
  }, locationOptions({
    altitude: true
  }));
  assert.equal(r.altitude, 31);
  assert.equal(r.verticalAccuracy, 7);
  assert.equal(r.speed, 2);
});
test("out-of-order responses and callbacks retain the original operation context in debug records", async () => {
  const events: any[] = [],
    resolves: Array<(v: any) => void> = [];
  setDebugEmitter(e => events.push(e));
  try {
    const wx = locationApis(() => new Promise(r => resolves.push(r)));
    const a = debugContext.run({
      operationId: "op-A"
    }, () => wx.getLocation({
      success: () => {}
    }));
    const b = debugContext.run({
      operationId: "op-B"
    }, () => wx.getLocation({
      success: () => {}
    }));
    resolves[1]({
      latitude: 2
    });
    await b;
    resolves[0]({
      latitude: 1
    });
    await a;
    assert.deepEqual(events.filter(e => e.phase === "success").map(e => [e.context.operationId, e.result.latitude]), [["op-B", 2], ["op-A", 1]]);
    assert.deepEqual(events.filter(e => e.callback === "complete").map(e => e.context.operationId), ["op-B", "op-A"]);
  } finally {
    setDebugEmitter(() => {});
  }
});

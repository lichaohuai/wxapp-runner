import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocationService } from "../src/location/service";
import { parseTool } from "../src/mcp/tools";
test("camera permission is explicit, persistent and separate from location and system devices", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-camera-permission-"));
  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));
  const file = path.join(dir, "permissions.json");
  let response: any = {
      confirm: false
    },
    prompts = 0;
  const provider: any = {
    available: false,
    name: "no-hardware",
    status: async () => "unavailable",
    locate: async () => {
      throw Error("OS should not be called");
    },
    close() {}
  };
  const create = () => new LocationService(provider, file, async () => {
    prompts++;
    return response;
  }, "wx" + "0000000000000001", "", () => {}, ["scope.camera"]);
  const s = create();
  assert.deepEqual(s.getSetting().authSetting, {});
  await assert.rejects(s.authorize({
    scope: "scope.camera"
  }), {
    runnerCode: "PERMISSION_DENIED"
  });
  await assert.rejects(s.authorize({
    scope: "scope.camera"
  }), {
    runnerCode: "PERMISSION_DENIED"
  });
  assert.equal(prompts, 1);
  response = {
    authSetting: {
      "scope.camera": true
    }
  };
  await s.openSetting();
  assert.deepEqual(create().getSetting().authSetting, {
    "scope.camera": true
  });
  s.debugLocation({
    mode: "simulated",
    latitude: 39.9,
    longitude: 116.4,
    accuracy: 25
  });
  response = {
    confirm: true
  };
  await s.getLocation({});
  assert.deepEqual(create().getSetting().authSetting, {
    "scope.camera": true,
    "scope.userLocation": true
  });
  response = {
    authSetting: {
      "scope.camera": false
    }
  };
  await s.openSetting();
  assert.deepEqual(s.getSetting().authSetting, {
    "scope.camera": false,
    "scope.userLocation": true
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  response = {
    authSetting: {
      "scope.record": true
    }
  };
  await assert.rejects(s.openSetting());
});
test("native camera MCP rejects incomplete and mixed inputs before touching the page", () => {
  for (const args of [{
    action: "scan",
    id: "x"
  }, {
    action: "camera-input",
    id: "x"
  }, {
    action: "camera-input",
    mode: "image"
  }, {
    action: "play",
    id: "x",
    file: "/tmp/image.png"
  }]) assert.throws(() => parseTool("runner_native", args));
  const parsed = parseTool("runner_native", {
    action: "camera-input",
    id: "x",
    mode: "simulated"
  });
  assert.ok("mode" in parsed);
  assert.equal(parsed.mode, "simulated");
});
test("native permission arrays and bot permission results retain local hardware authority", async () => {
  const {
    nativeAuthorization,
    mergeHardwareAuthorization
  } = await import("../src/location/native-contract");
  assert.deepEqual(nativeAuthorization({
    scope: ["scope.camera"],
    requestInQueue: true
  }), {
    scope: "scope.camera",
    requestInQueue: true
  });
  assert.throws(() => nativeAuthorization({
    scope: ["scope.camera", "scope.userLocation"]
  }));
  const remote = {
    data: JSON.stringify({
      err_no: 0,
      data: JSON.stringify({
        auth_item: [{
          scope: "scope.userInfo",
          state: 1
        }, {
          scope: "scope.camera",
          state: 1
        }, {
          scope: "scope.userLocation",
          state: 0
        }],
        other: "preserved"
      })
    })
  };
  const merged = JSON.parse(JSON.parse(mergeHardwareAuthorization(remote, {
    "scope.camera": false
  }).data).data);
  assert.deepEqual(merged, {
    auth_item: [{
      scope: "scope.userInfo",
      state: 1
    }, {
      scope: "scope.camera",
      state: 0
    }],
    other: "preserved"
  });
  assert.equal(JSON.parse(JSON.parse(remote.data).data).auth_item.length, 3);
});

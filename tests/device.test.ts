import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceRuntime } from "../src/device/runtime";
import { parseTool } from "../src/mcp/tools";
import { isRead } from "../src/controller/control";
import { systemInfo } from "../src/config";
test("AppBaseInfo exposes an independent host object without inventing an app identity", () => {
  assert.deepEqual(systemInfo.host, {});
  const device = new DeviceRuntime(systemInfo);
  for (const preset of ["pc", "android", "ios"]) {
    device.debug({ action: "preset", preset });
    const info = device.api.getAppBaseInfo();
    assert.deepEqual(info.host, {});
    assert.equal(info.host.appId, undefined);
    info.host.appId = "modified-by-business";
    assert.deepEqual(device.api.getAppBaseInfo().host, {});
    assert.deepEqual(device.api.getSystemInfoSync().host, {});
  }
});
test("device profile is explicit, invalid patches atomic, sensors honor start/stop/off, no hardware success by default", async () => {
  const d = new DeviceRuntime({ windowWidth: 390 });
  let samples: any[] = [];
  await assert.rejects(d.api.startCompass(), /./);
  d.debug({ action: "preset", preset: "android" });
  assert.equal(d.info().platform, "android");
  d.api.onCompassChange((v: any) => samples.push(v));
  d.debug({ action: "emit", event: "compass", data: { direction: 123 } });
  assert.equal(samples.length, 1);
  await d.api.stopCompass();
  assert.throws(
    () =>
      d.debug({ action: "emit", event: "compass", data: { direction: 124 } }),
    /stopped/,
  );
  assert.equal(samples.length, 1);
  await d.api.startCompass();
  d.api.offCompassChange();
  d.debug({ action: "emit", event: "compass", data: { direction: 124 } });
  assert.equal(samples.length, 1);
  const before = d.inspect();
  assert.throws(() =>
    d.debug({
      action: "set",
      state: { battery: { level: 105, isCharging: false } },
    }),
  );
  assert.deepEqual(d.inspect(), before);
  d.debug({ action: "preset", preset: "ios", simulation: false });
  assert.equal(d.info().platform, "ios");
  assert.equal((await d.api.getNetworkType()).networkType, "unknown");
  await assert.rejects(d.api.getBatteryInfo());
  assert.throws(() =>
    parseTool("runner_device", {
      action: "emit",
      event: "compass",
      data: { direction: 999 },
    }),
  );
  assert.equal(isRead("runner_device", parseTool("runner_device", {})), true);
  assert.equal(isRead("runner_device", { action: "set" }), false);
});
test("simulated BLE and Wi-Fi implement discovery, connection and destruction with real callback data", async () => {
  const d = new DeviceRuntime({});
  d.debug({ action: "preset", preset: "android" });
  d.debug({
    action: "set",
    state: {
      bluetoothDevices: [
        {
          deviceId: "test",
          name: "Peripheral",
          services: [
            {
              uuid: "service",
              characteristics: [
                {
                  uuid: "char",
                  properties: {
                    read: true,
                    write: true,
                    notify: true,
                    indicate: false,
                  },
                },
              ],
            },
          ],
        },
      ],
      wifiList: [
        {
          SSID: "Test WiFi",
          BSSID: "00:00:00:00:00:01",
          secure: false,
          signalStrength: 80,
        },
      ],
    },
  });
  await assert.rejects(d.api.createBLEConnection({ deviceId: "test" }));
  await d.api.openBluetoothAdapter();
  let found: any;
  d.api.onBluetoothDeviceFound((e: any) => (found = e));
  await d.api.startBluetoothDevicesDiscovery();
  assert.equal(found.devices[0].deviceId, "test");
  await d.api.createBLEConnection({ deviceId: "test" });
  assert.equal(
    (await d.api.getBLEDeviceServices({ deviceId: "test" })).services.length,
    1,
  );
  const p = {
    deviceId: "test",
    serviceId: "service",
    characteristicId: "char",
  };
  await d.api.writeBLECharacteristicValue({
    ...p,
    value: Uint8Array.from([0, 255, 2]).buffer,
  });
  let read: any;
  d.api.onBLECharacteristicValueChange((e: any) => (read = e));
  await d.api.readBLECharacteristicValue(p);
  assert.deepEqual([...new Uint8Array(read.value)], [0, 255, 2]);
  const injected = { ...p, value: [1, 2, 255] };
  assert.throws(
    () => d.debug({ action: "emit", event: "bleValue", data: injected }),
    /notification/,
  );
  await d.api.notifyBLECharacteristicValueChange({ ...p, state: true });
  d.debug(
    parseTool("runner_device", {
      action: "emit",
      event: "bleValue",
      data: { ...injected, serviceId: "SERVICE" },
    }),
  );
  assert.deepEqual([...new Uint8Array(read.value)], [1, 2, 255]);
  d.debug({
    action: "emit",
    event: "bleDisconnect",
    data: { deviceId: "test" },
  });
  await d.api.createBLEConnection({ deviceId: "test" });
  assert.throws(
    () => d.debug({ action: "emit", event: "bleValue", data: injected }),
    /notification/,
  );
  await d.api.closeBluetoothAdapter();
  await assert.rejects(d.api.readBLECharacteristicValue(p));
  await d.api.startWifi();
  await d.api.connectWifi({ SSID: "Test WiFi" });
  assert.equal((await d.api.getConnectedWifi()).wifi.SSID, "Test WiFi");
  await d.api.stopWifi();
  await assert.rejects(d.api.getConnectedWifi());
});

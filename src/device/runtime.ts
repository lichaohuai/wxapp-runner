import { z } from "zod";
import { asyncApi, type Options } from "../wx-shim/common";
import { emitDebug, debugContext, traceContext } from "../debug/context";
import type { Capability } from "../capabilities";
export const devicePresetSchema = z.enum(["pc", "android", "ios"]);
const vector = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
export const deviceEventSchemas = {
  bleValue: z
    .object({
      deviceId: z.string().min(1),
      serviceId: z.string().min(1),
      characteristicId: z.string().min(1),
      value: z.array(z.number().int().min(0).max(255)).max(65536),
    })
    .strict(),
  bleDisconnect: z.object({ deviceId: z.string().min(1) }).strict(),
  accelerometer: vector,
  gyroscope: vector,
  compass: z
    .object({
      direction: z.number().min(0).max(360),
      accuracy: z.union([z.number(), z.string()]).optional(),
    })
    .strict(),
  deviceMotion: z
    .object({
      alpha: z.number().finite(),
      beta: z.number().finite(),
      gamma: z.number().finite(),
    })
    .strict(),
  network: z
    .object({
      isConnected: z.boolean(),
      networkType: z.enum(["wifi", "2g", "3g", "4g", "5g", "unknown", "none"]),
    })
    .strict(),
  theme: z.object({ theme: z.enum(["light", "dark"]) }).strict(),
};
const characteristic = z.object({
  uuid: z.string().min(1),
  properties: z.object({
    read: z.boolean(),
    write: z.boolean(),
    notify: z.boolean(),
    indicate: z.boolean(),
  }),
});
const bluetoothDevice = z.object({
  deviceId: z.string().min(1),
  name: z.string(),
  localName: z.string().default(""),
  RSSI: z.number().default(-45),
  services: z
    .array(
      z.object({
        uuid: z.string().min(1),
        isPrimary: z.boolean().default(true),
        characteristics: z.array(characteristic).default([]),
      }),
    )
    .default([]),
});
export const deviceStateSchema = z
  .object({
    battery: z
      .object({
        level: z.number().int().min(0).max(100),
        isCharging: z.boolean(),
      })
      .optional(),
    bluetoothDevices: z.array(bluetoothDevice).max(100).optional(),
    wifiList: z
      .array(
        z.object({
          SSID: z.string(),
          BSSID: z.string(),
          secure: z.boolean(),
          signalStrength: z.number().min(0).max(100),
          frequency: z.number().optional(),
        }),
      )
      .max(100)
      .optional(),
  })
  .strict();
const eventNames: Record<string, string> = {
  accelerometer: "AccelerometerChange",
  compass: "CompassChange",
  gyroscope: "GyroscopeChange",
  deviceMotion: "DeviceMotionChange",
  network: "NetworkStatusChange",
  theme: "ThemeChange",
};
/** Session-local simulated hardware. Real UI/business callbacks still execute unchanged. */
export class DeviceRuntime {
  private registry: Capability[] = [];
  setCapabilities(rows: Capability[]) {
    this.registry = rows;
  }
  private profile: "pc" | "android" | "ios" = "pc";
  private enabled = false;
  private listeners = new Map<string, Set<Function>>();
  private running = new Set<string>();
  private stopped = new Set<string>();
  private values: any = {
    battery: { level: 100, isCharging: true },
    bluetoothDevices: [],
    wifiList: [],
    network: { isConnected: null, networkType: "unknown" },
    theme: { theme: "light" },
  };
  private bluetooth = false;
  private discovering = false;
  private connections = new Set<string>();
  private notifications = new Set<string>();
  private wifi = false;
  private connectedWifi: any;
  readonly api: Record<string, any> = {};
  constructor(
    private baseInfo: any,
    private notify: (name: string, data: any) => void = () => {},
  ) {
    const api = this.api;
    const invoke =
      (name: string, fn: (o: any) => any) =>
      (o: Options = {}) =>
        asyncApi(name, o, async () => {
          emitDebug("device-api", {
            api: name,
            phase: "start",
            simulated: this.enabled,
          });
          return fn(o);
        });
    const on = (name: string, callback: Function) => {
      if (typeof callback !== "function")
        throw Error("Listener must be a function");
      let callbacks = this.listeners.get(name);
      if (!callbacks) this.listeners.set(name, (callbacks = new Set()));
      callbacks.add(callback);
    };
    const off = (name: string, callback?: Function) => {
      if (callback === undefined) this.listeners.delete(name);
      else this.listeners.get(name)?.delete(callback);
    };
    for (const event of [
      ...Object.values(eventNames),
      "BluetoothAdapterStateChange",
      "BluetoothDeviceFound",
      "BLEConnectionStateChange",
      "BLECharacteristicValueChange",
      "WifiConnected",
      "GetWifiList",
      "WifiConnectedWithPartialInfo",
    ]) {
      api["on" + event] = (callback: Function) => on(event, callback);
      api["off" + event] = (callback?: Function) => off(event, callback);
    }
    for (const [kind, method] of Object.entries({
      accelerometer: "Accelerometer",
      compass: "Compass",
      gyroscope: "Gyroscope",
      deviceMotion: "DeviceMotionListening",
    })) {
      const event = eventNames[kind];
      api["start" + method] = invoke("start" + method, () => {
        this.requireSimulation();
        this.running.add(kind);
        this.stopped.delete(kind);
        return {};
      });
      api["stop" + method] = invoke("stop" + method, () => {
        this.running.delete(kind);
        this.stopped.add(kind);
        return {};
      });
      // Legacy compass/accelerometer subscriptions start default sampling.
      if (["compass", "accelerometer"].includes(kind))
        api["on" + event] = (cb: Function) => {
          on(event, cb);
          if (this.enabled && !this.stopped.has(kind)) this.running.add(kind);
        };
    }
    api.getSystemInfoSync = () => this.info();
    for (const name of ["getAppBaseInfo", "getDeviceInfo", "getWindowInfo"])
      api[name] = () => this.info();
    for (const name of ["getSystemInfo", "getSystemInfoAsync"])
      api[name] = invoke(name, () => this.info());
    api.getBatteryInfoSync = () => {
      this.requireSimulation();
      return { ...this.values.battery };
    };
    api.getBatteryInfo = invoke("getBatteryInfo", api.getBatteryInfoSync);
    api.getNetworkType = invoke("getNetworkType", () => ({
      networkType: this.enabled ? this.values.network.networkType : "unknown",
    }));
    for (const name of ["vibrateShort", "vibrateLong"])
      api[name] = invoke(name, () => {
        this.requireSimulation();
        emitDebug("device-output", { api: name, simulated: true });
        return {};
      });
    api.openBluetoothAdapter = invoke("openBluetoothAdapter", () => {
      this.requireSimulation();
      this.bluetooth = true;
      this.emit("BluetoothAdapterStateChange", {
        available: true,
        discovering: false,
      });
      return {};
    });
    api.closeBluetoothAdapter = invoke("closeBluetoothAdapter", () => {
      for (const id of this.connections)
        this.emit("BLEConnectionStateChange", {
          deviceId: id,
          connected: false,
        });
      this.connections.clear();
      this.notifications.clear();
      this.bluetooth = false;
      this.discovering = false;
      this.emit("BluetoothAdapterStateChange", {
        available: false,
        discovering: false,
      });
      return {};
    });
    api.getBluetoothAdapterState = invoke("getBluetoothAdapterState", () => {
      this.requireBluetooth();
      return { available: true, discovering: this.discovering };
    });
    api.startBluetoothDevicesDiscovery = invoke(
      "startBluetoothDevicesDiscovery",
      () => {
        this.requireBluetooth();
        this.discovering = true;
        this.emit("BluetoothAdapterStateChange", {
          available: true,
          discovering: true,
        });
        queueMicrotask(() => {
          if (this.discovering)
            this.emit("BluetoothDeviceFound", {
              devices: this.values.bluetoothDevices.map((d: any) =>
                this.deviceInfo(d),
              ),
            });
        });
        return {};
      },
    );
    api.stopBluetoothDevicesDiscovery = invoke(
      "stopBluetoothDevicesDiscovery",
      () => {
        this.requireBluetooth();
        this.discovering = false;
        this.emit("BluetoothAdapterStateChange", {
          available: true,
          discovering: false,
        });
        return {};
      },
    );
    api.getBluetoothDevices = invoke("getBluetoothDevices", () => {
      this.requireBluetooth();
      return {
        devices: this.values.bluetoothDevices.map((d: any) =>
          this.deviceInfo(d),
        ),
      };
    });
    api.getConnectedBluetoothDevices = invoke(
      "getConnectedBluetoothDevices",
      () => {
        this.requireBluetooth();
        return {
          devices: this.values.bluetoothDevices
            .filter((d: any) => this.connections.has(d.deviceId))
            .map((d: any) => this.deviceInfo(d)),
        };
      },
    );
    api.createBLEConnection = invoke("createBLEConnection", (o) => {
      const d = this.device(o.deviceId);
      this.connections.add(d.deviceId);
      this.emit("BLEConnectionStateChange", {
        deviceId: d.deviceId,
        connected: true,
      });
      return {};
    });
    api.closeBLEConnection = invoke("closeBLEConnection", (o) => {
      this.device(o.deviceId);
      if (!this.connections.delete(o.deviceId))
        throw Error("BLE device is not connected");
      this.clearNotifications(o.deviceId);
      this.emit("BLEConnectionStateChange", {
        deviceId: o.deviceId,
        connected: false,
      });
      return {};
    });
    api.getBLEDeviceServices = invoke("getBLEDeviceServices", (o) => ({
      services: this.device(o.deviceId, true).services.map(
        ({ characteristics, ...s }: any) => s,
      ),
    }));
    api.getBLEDeviceCharacteristics = invoke(
      "getBLEDeviceCharacteristics",
      (o) => ({ characteristics: this.service(o).characteristics }),
    );
    api.notifyBLECharacteristicValueChange = invoke(
      "notifyBLECharacteristicValueChange",
      (o) => {
        const c = this.char(o);
        if (!(c.properties.notify || c.properties.indicate))
          throw Error("Characteristic does not support notifications");
        const key = this.key(o);
        o.state ? this.notifications.add(key) : this.notifications.delete(key);
        return {};
      },
    );
    api.writeBLECharacteristicValue = invoke(
      "writeBLECharacteristicValue",
      (o) => {
        const c = this.char(o);
        if (!c.properties.write) throw Error("Characteristic is not writable");
        if (Object.prototype.toString.call(o.value) !== "[object ArrayBuffer]")
          throw Error("value must be ArrayBuffer");
        this.values[this.key(o)] = Buffer.from(o.value).toString("base64");
        return {};
      },
    );
    api.readBLECharacteristicValue = invoke(
      "readBLECharacteristicValue",
      (o) => {
        const c = this.char(o);
        if (!c.properties.read) throw Error("Characteristic is not readable");
        const value = this.values[this.key(o)];
        if (value === undefined)
          throw Error("No simulated characteristic value supplied");
        this.emit("BLECharacteristicValueChange", {
          deviceId: o.deviceId,
          serviceId: o.serviceId,
          characteristicId: o.characteristicId,
          value: Uint8Array.from(Buffer.from(value, "base64")).buffer,
        });
        return {};
      },
    );
    api.startWifi = invoke("startWifi", () => {
      this.requireSimulation();
      this.wifi = true;
      return {};
    });
    api.stopWifi = invoke("stopWifi", () => {
      this.wifi = false;
      this.connectedWifi = undefined;
      return {};
    });
    api.getWifiList = invoke("getWifiList", () => {
      this.requireWifi();
      queueMicrotask(() => {
        if (this.wifi)
          this.emit("GetWifiList", {
            wifiList: structuredClone(this.values.wifiList),
          });
      });
      return {};
    });
    api.connectWifi = invoke("connectWifi", (o) => {
      this.requireWifi();
      const wifi = this.values.wifiList.find(
        (w: any) => w.SSID === o.SSID && (!o.BSSID || w.BSSID === o.BSSID),
      );
      if (!wifi) throw Error("Simulated Wi-Fi network not found");
      this.connectedWifi = wifi;
      this.emit("WifiConnected", { wifi: structuredClone(wifi) });
      this.emit("WifiConnectedWithPartialInfo", { wifi: { SSID: wifi.SSID } });
      return {};
    });
    api.getConnectedWifi = invoke("getConnectedWifi", () => {
      this.requireWifi();
      if (!this.connectedWifi) throw Error("No connected Wi-Fi");
      return { wifi: structuredClone(this.connectedWifi) };
    });
  }
  private requireSimulation() {
    if (!this.enabled)
      throw Object.assign(
        Error(
          "Simulated device input is disabled; explicitly enable a device preset in Wxapp",
        ),
        { runnerCode: "DEVICE_SIMULATION_DISABLED" },
      );
  }
  private requireBluetooth() {
    this.requireSimulation();
    if (!this.bluetooth)
      throw Object.assign(Error("Bluetooth adapter is not initialized"), {
        runnerCode: "BLUETOOTH_NOT_INITIALIZED",
      });
  }
  private requireWifi() {
    this.requireSimulation();
    if (!this.wifi) throw Error("Wi-Fi is not started");
  }
  private device(id: string, connected = false): any {
    this.requireBluetooth();
    const d = this.values.bluetoothDevices.find((d: any) => d.deviceId === id);
    if (!d) throw Error("Simulated Bluetooth device not found");
    if (connected && !this.connections.has(id))
      throw Error("BLE device is not connected");
    return d;
  }
  private deviceInfo({ services, ...d }: any) {
    return {
      ...d,
      advertisData: new ArrayBuffer(0),
      advertisServiceUUIDs: services.map((s: any) => s.uuid),
    };
  }
  private service(o: any) {
    const s = this.device(o.deviceId, true).services.find(
      (s: any) => s.uuid.toLowerCase() === String(o.serviceId).toLowerCase(),
    );
    if (!s) throw Error("BLE service not found");
    return s;
  }
  private char(o: any) {
    const c = this.service(o).characteristics.find(
      (c: any) =>
        c.uuid.toLowerCase() === String(o.characteristicId).toLowerCase(),
    );
    if (!c) throw Error("BLE characteristic not found");
    return c;
  }
  private key(o: any) {
    return JSON.stringify([
      o.deviceId,
      String(o.serviceId).toLowerCase(),
      String(o.characteristicId).toLowerCase(),
    ]);
  }
  private clearNotifications(deviceId: string) {
    for (const key of this.notifications)
      if (JSON.parse(key)[0] === deviceId) this.notifications.delete(key);
  }
  private emit(name: string, data: any) {
    emitDebug("device-event", { event: name, simulated: this.enabled, data });
    this.notify(name, data);
    for (const callback of [...(this.listeners.get(name) || [])])
      try {
        callback(data);
      } catch (error) {
        emitDebug("device-callback-error", { event: name, error });
      }
  }
  info() {
    const preset =
      this.profile === "pc"
        ? {
            platform:
              process.platform === "darwin"
                ? "mac"
                : process.platform === "win32"
                  ? "windows"
                  : "linux",
            system:
              process.platform === "darwin"
                ? "macOS"
                : process.platform === "win32"
                  ? "Windows"
                  : "Linux",
            model: "WxappRunner PC",
          }
        : this.profile === "ios"
          ? {
              platform: "ios",
              system: "iOS 18.0",
              model: "WxappRunner iPhone simulator",
            }
          : {
              platform: "android",
              system: "Android 14",
              model: "WxappRunner Android simulator",
            };
    return {
      ...this.baseInfo,
      ...preset,
      host: { ...this.baseInfo.host },
      theme: this.enabled
        ? this.values.theme.theme
        : this.baseInfo.theme || "light",
    };
  }
  inspect() {
    return {
      profile: this.profile,
      simulationEnabled: this.enabled,
      publicInfo: this.info(),
      internalBridgePlatform: "android",
      sensors: [...this.running],
      state: structuredClone(this.values),
      bluetooth: {
        available: this.bluetooth,
        discovering: this.discovering,
        connected: [...this.connections],
      },
      wifi: {
        started: this.wifi,
        connected: structuredClone(this.connectedWifi),
      },
      capabilities: Object.keys(this.api).sort(),
      apiRegistry: this.registry,
      acceptance: "Registry presence is not per-page flow or effect acceptance",
      scope: "runtime-session",
      nativeEffects: { skyline: false, xr: false, ai: false },
    };
  }
  debug(args: any) {
    return debugContext.run(
      traceContext({ kind: "device", handler: "runner_device." + args.action }),
      () => {
        if (args.action === "get" || args.action === "capabilities")
          return this.inspect();
        if (args.action === "preset") {
          const profile = devicePresetSchema.parse(args.preset);
          this.profile = profile;
          this.enabled = args.simulation !== false;
          this.running.clear();
          this.stopped.clear();
          this.connections.clear();
          this.notifications.clear();
          this.bluetooth = false;
          this.discovering = false;
          this.wifi = false;
          this.connectedWifi = undefined;
          emitDebug("device-preset", { profile, simulated: this.enabled });
          return this.inspect();
        }
        if (args.action === "set") {
          const next = deviceStateSchema.parse(args.state);
          this.requireSimulation();
          if (next.bluetoothDevices && this.connections.size)
            throw Error(
              "Disconnect BLE devices before replacing the peripheral inventory",
            );
          if (next.bluetoothDevices) {
            const unique = (items: string[]) =>
              new Set(items).size === items.length;
            if (
              !unique(next.bluetoothDevices.map((d) => d.deviceId)) ||
              next.bluetoothDevices.some(
                (d) =>
                  !unique(d.services.map((s) => s.uuid.toLowerCase())) ||
                  d.services.some(
                    (s) =>
                      !unique(
                        s.characteristics.map((c) => c.uuid.toLowerCase()),
                      ),
                  ),
              )
            )
              throw Error("Duplicate BLE identity");
          }
          Object.assign(this.values, next);
          emitDebug("device-state", { patch: next, simulated: true });
          return this.inspect();
        }
        if (args.action === "emit") {
          const schema =
            deviceEventSchemas[args.event as keyof typeof deviceEventSchemas];
          if (!schema) throw Error("Unknown device event");
          const data = schema.parse(args.data);
          this.requireSimulation();
          if (args.event === "bleValue") {
            const sample = data as any;
            this.char(sample);
            if (!this.notifications.has(this.key(sample)))
              throw Error(
                "BLE notification is not enabled; no event delivered",
              );
            this.values[this.key(sample)] = Buffer.from(sample.value).toString(
              "base64",
            );
            this.emit("BLECharacteristicValueChange", {
              ...sample,
              value: Uint8Array.from(sample.value).buffer,
            });
          } else if (args.event === "bleDisconnect") {
            const { deviceId } = data as any;
            this.device(deviceId, true);
            this.connections.delete(deviceId);
            this.clearNotifications(deviceId);
            this.emit("BLEConnectionStateChange", {
              deviceId,
              connected: false,
            });
          } else {
            if (
              !["network", "theme"].includes(args.event) &&
              !this.running.has(args.event)
            )
              throw Error("Sensor is stopped; no event was delivered");
            this.values[args.event] = data;
            this.emit(eventNames[args.event], data);
          }
          return {
            status: "event-delivered",
            simulated: true,
            businessCompleted: false,
          };
        }
        throw Error("Unknown device action");
      },
    );
  }
}

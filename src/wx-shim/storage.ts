import { emitDebug } from "../debug/context";
import fs from "node:fs";
import path from "node:path";
import { success, failure, type Options } from "./common";
import { encodeStorageData, decodeStorageData } from "./storage-codec";
export function storageApi(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let entries: any = Object.create(null);
  let legacy: string | undefined;
  if (fs.existsSync(file)) {
    const contents = fs.readFileSync(file, "utf8");
    const saved = JSON.parse(contents);
    const typed =
      saved.$wxappStorageVersion === 1 &&
      saved.entries &&
      Object.keys(saved).length === 2;
    if (!typed) legacy = contents;
    // Old Runner profiles contain plain values. Migrate only on the next write.
    entries = Object.assign(
      Object.create(null),
      typed
        ? saved.entries
        : Object.fromEntries(
            Object.entries(saved).map(([k, v]) => [k, encodeStorageData(v)]),
          ),
    );
  }
  const persist = (next: any) => {
    const temp = file + ".tmp";
    fs.writeFileSync(
      temp,
      JSON.stringify({ $wxappStorageVersion: 1, entries: next }),
      { mode: 0o600 },
    );
    if (legacy !== undefined) {
      try {
        fs.writeFileSync(file + ".legacy-backup", legacy, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    fs.renameSync(temp, file);
    legacy = undefined;
    entries = next;
  };
  function getStorageSync(key: string) {
    return Object.hasOwn(entries, key) ? decodeStorageData(entries[key]) : "";
  }
  function setStorageSync(key: string, data: any) {
    const before = getStorageSync(key);
    const next = Object.assign(Object.create(null), entries);
    next[key] = encodeStorageData(data);
    persist(next);
    emitDebug("storage", {
      action: "set",
      key,
      before,
      value: getStorageSync(key),
      stack: new Error().stack,
    });
  }
  function removeStorageSync(key: string) {
    const before = getStorageSync(key);
    const next = Object.assign(Object.create(null), entries);
    delete next[key];
    persist(next);
    emitDebug("storage", {
      action: "remove",
      key,
      before,
      stack: new Error().stack,
    });
  }
  function clearStorageSync() {
    const keys = Object.keys(entries);
    persist(Object.create(null));
    emitDebug("storage", { action: "clear", keys, stack: new Error().stack });
  }
  function getStorageInfoSync() {
    return {
      keys: Object.keys(entries),
      currentSize: Math.ceil(Buffer.byteLength(JSON.stringify(entries)) / 1024),
      limitSize: 10240,
    };
  }
  function getStorage(o: Options) {
    queueMicrotask(() =>
      Object.hasOwn(entries, o.key)
        ? success("getStorage", o, { data: getStorageSync(o.key) })
        : failure("getStorage", o, Error("data not found")),
    );
  }
  function setStorage(o: Options) {
    try {
      setStorageSync(o.key, o.data);
      queueMicrotask(() => success("setStorage", o));
    } catch (e) {
      queueMicrotask(() => failure("setStorage", o, e));
    }
  }
  function removeStorage(o: Options) {
    try {
      removeStorageSync(o.key);
      queueMicrotask(() => success("removeStorage", o));
    } catch (e) {
      queueMicrotask(() => failure("removeStorage", o, e));
    }
  }
  function clearStorage(o: Options = {}) {
    try {
      clearStorageSync();
      queueMicrotask(() => success("clearStorage", o));
    } catch (e) {
      queueMicrotask(() => failure("clearStorage", o, e));
    }
  }
  function getStorageInfo(o: Options = {}) {
    queueMicrotask(() => success("getStorageInfo", o, getStorageInfoSync()));
  }
  return {
    getStorageSync,
    setStorageSync,
    removeStorageSync,
    clearStorageSync,
    getStorageInfoSync,
    getStorage,
    setStorage,
    removeStorage,
    clearStorage,
    getStorageInfo,
  };
}

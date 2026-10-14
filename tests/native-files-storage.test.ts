import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostApis } from "../src/wx-shim/host";
import { createWxShim } from "../src/wx-shim";
import { NativeFilesStorage } from "../src/native-components/files-storage";
import { encodeStorageData, decodeStorageData } from "../src/wx-shim/storage-codec";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-native-host-"));
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const config = {
    packageDir: path.join(root, "package"),
    dataDir: path.join(root, "data/files"),
    storageFile: path.join(root, "data/storage.json"),
    app: {}
  };
  fs.mkdirSync(config.packageDir);
  const host = createHostApis(config, () => {});
  const buffers = new Map<number, ArrayBuffer>();
  const native = new NativeFilesStorage(host, id => {
    const b = buffers.get(id);
    buffers.delete(id);
    return b;
  });
  const sync = (name: string, args: any = {}) => JSON.parse(native.invoke(name, args, () => assert.fail("sync API must not deliver a second callback"))!);
  const asyncCall = (name: string, args: any = {}) => new Promise<any>(resolve => {
    let returned = false;
    assert.equal(native.invoke(name, args, r => {
      assert.equal(returned, true);
      resolve(r);
    }), "");
    returned = true;
  });
  return {
    config,
    host,
    native,
    buffers,
    sync,
    asyncCall
  };
}
test("native storage and two wx contexts share updates without stale snapshots; restart preserves typed values", async t => {
  const {
    config,
    host,
    sync,
    asyncCall
  } = fixture(t);
  const first = createWxShim({}, config, async () => ({}), () => {}, undefined, host);
  const second = createWxShim({}, config, async () => ({}), () => {}, undefined, host);
  first.setStorageSync("app", {
    text: "中文🙂",
    flag: false
  });
  assert.deepEqual(decodeStorageData(sync("getStorageSync", {
    key: "app",
    storageId: 0
  })), {
    text: "中文🙂",
    flag: false
  });
  const key = "__plugins__/" + ("wx" + "0000000000000006") + "/sample";
  for (const value of ["", 0, false, null, undefined, new Date(123456), {
    nested: [1, "北京"]
  }]) {
    const result = await asyncCall("setStorage", {
      key,
      storageId: 0,
      ...encodeStorageData(value)
    });
    assert.equal(result.errMsg, "setStorage:ok");
    assert.deepEqual(second.getStorageSync(key), value);
    assert.deepEqual(createHostApis(config, () => {}).storage.getStorageSync(key), value);
  }
  second.setStorageSync("other", 2);
  assert.equal(first.getStorageSync("other"), 2);
  assert.deepEqual(first.getStorageSync("app"), {
    text: "中文🙂",
    flag: false
  });
  assert.equal((await asyncCall("getStorage", {
    key: "absent"
  })).errMsg, "getStorage:fail data not found");
  sync("setStorageSync", {
    key: "app",
    storageId: 1,
    ...encodeStorageData("opendata")
  });
  assert.notEqual(first.getStorageSync("app"), "opendata");
  assert.match(sync("setStorageSync", {
    key: "x",
    storageId: -1,
    ...encodeStorageData(1)
  }).errMsg, /fail/);
  assert.match(sync("setStorageSync", {
    key: "broken",
    data: "{",
    dataType: "Object"
  }).errMsg, /fail/);
  assert.ok(!first.getStorageInfoSync().keys.includes("broken"));
});
test("native filesystem preserves binary bytes, slices, callback timing, stat fields and package read-only", async t => {
  const {
    host,
    config,
    buffers,
    sync,
    asyncCall
  } = fixture(t);
  const dir = "wxfile://usr/__plugins__/" + ("wx" + "0000000000000006"),
    file = dir + "/value.bin";
  assert.equal(sync("mkdirSync", {
    dirPath: dir,
    recursive: true
  }).errMsg, "mkdirSync:ok");
  const bytes = new Uint8Array([0, 255, 128, 1]).buffer;
  buffers.set(1, bytes);
  assert.equal((await asyncCall("writeFile", {
    filePath: file,
    __nativeBuffers__: [{
      key: "data",
      id: 1
    }]
  })).errMsg, "writeFile:ok");
  assert.equal(buffers.size, 0);
  const read = await asyncCall("readFile", {
    filePath: file
  });
  assert.deepEqual(Buffer.from(read.__nativeBuffers__[0].base64, "base64"), Buffer.from(bytes));
  assert.deepEqual(Buffer.from(sync("readFileSync", {
    filePath: file,
    position: 1,
    length: 2
  }).__nativeBuffers__[0].base64, "base64"), Buffer.from([255, 128]));
  assert.match(sync("readFileSync", {
    filePath: file,
    position: 3,
    length: 2
  }).errMsg, /out of range/);
  assert.equal(sync("statSync", {
    path: file
  }).size, 4);
  assert.ok(sync("statSync", {
    path: file
  }).lastModifiedTime < Date.now() / 100);
  assert.ok(sync("statSync", {
    path: dir,
    recursive: true
  }).stats["value.bin"]);
  fs.writeFileSync(path.join(config.packageDir, "asset.txt"), "package text");
  assert.equal(sync("readFileSync", {
    filePath: "asset.txt",
    encoding: "utf8"
  }).data, "package text");
  assert.match(sync("writeFileSync", {
    filePath: "/asset.txt",
    data: "bad"
  }).errMsg, /read-only/);
  assert.match(sync("writeFileSync", {
    filePath: "asset.txt",
    data: "bad"
  }).errMsg, /read-only/);
  const textFile = dir + "/中文.txt";
  sync("writeFileSync", {
    filePath: textFile,
    data: "中文🙂",
    encoding: "utf8"
  });
  assert.equal(host.files.api.getFileSystemManager().readFileSync(textFile, "utf8"), "中文🙂");
  assert.equal((await asyncCall("fs_appendFile", {
    filePath: textFile,
    data: "追加"
  })).errMsg, "fs_appendFile:ok");
  assert.equal(sync("readFileSync", {
    filePath: textFile,
    encoding: "utf8"
  }).data, "中文🙂追加");
  const failure = await asyncCall("access", {
    path: dir + "/absent"
  });
  assert.match(failure.errMsg, /access:fail ENOENT/);
  assert.ok(!failure.errMsg.includes(config.dataDir));
  sync("mkdirSync", {
    dirPath: "wxfile://usr/tmp",
    recursive: true
  });
  sync("writeFileSync", {
    filePath: "wxfile://tmp/saving.bin",
    data: "temporary"
  });
  const saved = await asyncCall("saveFile", {
    tempFilePath: "wxfile://tmp/saving.bin"
  });
  assert.equal(saved.errMsg, "saveFile:ok");
  assert.match(sync("accessSync", {
    path: "wxfile://tmp/saving.bin"
  }).errMsg, /fail ENOENT/);
  assert.equal(sync("readFileSync", {
    filePath: saved.savedFilePath,
    encoding: "utf8"
  }).data, "temporary");
  assert.ok(sync("readdirSync", {
    dirPath: "wxfile://usr"
  }).files.includes(saved.savedFilePath.split("/").at(-1)));
  assert.equal((await asyncCall("unlink", {
    filePath: saved.savedFilePath
  })).errMsg, "unlink:ok");
});
test("native file paths retain grants and reject traversal, symlinks and unsupported protocols", async t => {
  const {
    host,
    config,
    sync
  } = fixture(t);
  const external = path.join(path.dirname(config.packageDir), "chosen.txt");
  fs.writeFileSync(external, "chosen");
  host.files.grant(external);
  assert.equal(sync("readFileSync", {
    filePath: external,
    encoding: "utf8"
  }).data, "chosen");
  assert.equal(sync("saveFileSync", {
    tempFilePath: external,
    filePath: "wxfile://usr/imported.txt"
  }).errMsg, "saveFileSync:ok");
  assert.equal(fs.readFileSync(external, "utf8"), "chosen");
  assert.match(sync("writeFileSync", {
    filePath: external,
    data: "bad"
  }).errMsg, /fail/);
  fs.symlinkSync(path.dirname(config.packageDir), path.join(config.dataDir, "escape"));
  for (const filePath of ["wxfile://usr/../storage.json", "wxfile://usr/escape/chosen.txt", "https://example.com/a", "wxfile://bad/a"]) assert.match(sync("readFileSync", {
    filePath
  }).errMsg, /fail/);
  for (const scope of ["sdk", "ad", "__wxprivate__"]) {
    const filePath = `wxfile://${scope}/state`;
    assert.equal(sync("writeFileSync", {
      filePath,
      data: "local"
    }).errMsg, "writeFileSync:ok");
    assert.equal(sync("readFileSync", {
      filePath,
      encoding: "utf8"
    }).data, "local");
    assert.throws(() => host.files.api.getFileSystemManager().readFileSync(filePath), /permission denied/);
    assert.match(sync("readFileSync", {
      filePath: `wxfile://${scope}/../state`
    }).errMsg, /fail/);
  }
});
test("legacy storage migrates without losing values and a failed persist leaves memory unchanged", t => {
  const {
    config
  } = fixture(t);
  fs.writeFileSync(config.storageFile, '{"old":{"flag":false}}');
  const host = createHostApis(config, () => {});
  host.storage.setStorageSync("next", 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.storageFile + ".legacy-backup", "utf8")), {
    old: {
      flag: false
    }
  });
  assert.equal(fs.statSync(config.storageFile + ".legacy-backup").mode & 0o777, 0o600);
  assert.deepEqual(createHostApis(config, () => {}).storage.getStorageSync("old"), {
    flag: false
  });
  fs.mkdirSync(config.storageFile + ".tmp");
  assert.throws(() => host.storage.setStorageSync("next", 99));
  assert.equal(host.storage.getStorageSync("next"), 42);
});
test("a thrown filesystem success callback completes once and is not converted into a fail callback", t => {
  const {
    host,
    config
  } = fixture(t);
  fs.writeFileSync(path.join(config.packageDir, "callback.txt"), "ok");
  const tasks: VoidFunction[] = [],
    counts = {
      success: 0,
      fail: 0,
      complete: 0
    };
  const enqueue = globalThis.queueMicrotask;
  try {
    globalThis.queueMicrotask = fn => {
      tasks.push(fn);
    };
    host.files.api.getFileSystemManager().readFile({
      filePath: "callback.txt",
      encoding: "utf8",
      success() {
        counts.success++;
        throw Error("business callback failed");
      },
      fail() {
        counts.fail++;
      },
      complete() {
        counts.complete++;
      }
    });
  } finally {
    globalThis.queueMicrotask = enqueue;
  }
  assert.equal(tasks.length, 1);
  assert.throws(tasks[0], /business callback failed/);
  assert.deepEqual(counts, {
    success: 1,
    fail: 0,
    complete: 1
  });
});

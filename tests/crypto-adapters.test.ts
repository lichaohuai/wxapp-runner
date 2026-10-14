import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createHash, createHmac } from "node:crypto";
import { buildSync } from "esbuild";
import { installBootAnalysis } from "../src/analysis/boot";
import { summarizeCrypto } from "../src/analysis/crypto-evidence";
const require = createRequire(import.meta.url);
function library(name: string) {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(
    'globalThis.window=globalThis;globalThis.self=globalThis;globalThis.navigator={appName:"Netscape"};',
    context,
  );
  vm.runInContext(
    'globalThis.factories={};globalThis.define=function(n,f){factories[n]=f};globalThis.require=function(n){if(!factories[n])throw Error("missing module:"+n);const m={exports:{}};factories[n](require,m,m.exports);return m.exports;}',
    context,
  );
  installBootAnalysis(context, {
    enabled: true,
    cryptoTap: true,
    webCrypto: true,
    ttlMs: 10000,
  });
  const source =
    name === "crypto-js"
      ? fs.readFileSync(require.resolve("crypto-js/crypto-js.js"), "utf8")
      : buildSync({
          entryPoints: [require.resolve(name)],
          bundle: true,
          platform: "browser",
          format: "cjs",
          write: false,
        }).outputFiles[0].text;
  vm.runInContext(
    `define(${JSON.stringify(name)},function(require,module,exports){${source}\n});globalThis.lib=require(${JSON.stringify(name)});`,
    context,
  );
  const api = vm.runInContext("__wxappBootAnalysisV1", context);
  return {
    context,
    api,
    run: (code: string) => vm.runInContext(code, context),
    close: () => api.command({ action: "stop" }),
  };
}
test("actual CryptoJS MD5/SHA256/HMAC/AES entry points expose real WordArray output and explicit inputs", () => {
  const r = library("crypto-js");
  try {
    const expected = createHash("md5").update("abc").digest("hex"),
      w = r.api.command({
        action: "start",
        target: expected,
        match: "exact",
        count: 1,
        ttlMs: 1000,
      });
    assert.equal(r.run('lib.MD5("abc").toString()'), expected);
    assert.equal(
      r.api.read({ watchId: w.watchId, limit: 10 }).entries[0].input,
      "abc",
    );
    assert.equal(
      r.run('lib.SHA256("abc").toString()'),
      createHash("sha256").update("abc").digest("hex"),
    );
    assert.equal(
      r.run('lib.HmacSHA256("abc","fixture-key").toString()'),
      createHmac("sha256", "fixture-key").update("abc").digest("hex"),
    );
    r.run(
      'globalThis.fixtureKey=lib.enc.Hex.parse("000102030405060708090a0b0c0d0e0f");globalThis.fixtureIv=lib.enc.Hex.parse("101112131415161718191a1b1c1d1e1f");globalThis.encrypted=lib.AES.encrypt("中文😀",fixtureKey,{iv:fixtureIv});',
    );
    assert.equal(
      r.run(
        "lib.AES.decrypt(encrypted,fixtureKey,{iv:fixtureIv}).toString(lib.enc.Utf8)",
      ),
      "中文😀",
    );
    const rows = r.api.read({ limit: 100 }).entries;
    assert.ok(
      rows.some(
        (e: any) =>
          e.algo === "crypto-js.AES.encrypt" &&
          e.input === "中文😀" &&
          e.key.data === "000102030405060708090a0b0c0d0e0f",
      ),
    );
    assert.ok(
      rows.some(
        (e: any) =>
          e.algo === "crypto-js.AES.encrypt" &&
          e.iv.data === "101112131415161718191a1b1c1d1e1f",
      ),
    );
    assert.ok(
      rows.some(
        (e: any) =>
          e.algo === "crypto-js.HmacSHA256" && e.key === "fixture-key",
      ),
    );
    const evidence = summarizeCrypto(rows);
    assert.equal(evidence.counts.verified, 5);
    const aes = evidence.steps.find(
      (e) => e.label === "crypto-js.AES.encrypt",
    )!;
    assert.equal(aes.metadata.mode, "CBC");
    assert.equal(aes.metadata.padding, "Pkcs7");
    assert.equal(aes.inputFormat.bytes, Buffer.byteLength("中文😀"));
    assert.equal(aes.verification.status, "verified");
  } finally {
    r.close();
  }
});
test("CryptoJS ECB/NoPadding metadata uses real references and refuses passphrases, accessors and unknown options", () => {
  const r = library("crypto-js");
  try {
    r.run(
      'var key=lib.enc.Hex.parse("000102030405060708090a0b0c0d0e0f");lib.AES.encrypt("0123456789abcdef",key,{mode:lib.mode.ECB,padding:lib.pad.NoPadding});',
    );
    let result = summarizeCrypto(r.api.read({ limit: 100 }).entries).steps.find(
      (s) => s.metadata.algorithm === "AES",
    )!;
    assert.equal(result.metadata.mode, "ECB");
    assert.equal(result.metadata.padding, "NoPadding");
    assert.equal(result.verification.status, "verified");
    const before = r.api.read({ limit: 100 }).latestCursor;
    r.run(
      'var reads=0;var cfg={mode:lib.mode.ECB};Object.defineProperty(cfg,"padding",{enumerable:true,get:function(){reads++;return lib.pad.Pkcs7;}});lib.AES.encrypt("fixture",key,cfg);',
    );
    assert.equal(
      r.run("reads"),
      1,
      "only original library may invoke option getter",
    );
    result = summarizeCrypto(
      r.api.read({ after: before, limit: 100 }).entries,
    ).steps.find((s) => s.metadata.algorithm === "AES")!;
    assert.equal(result.metadata.padding, "unknown");
    assert.equal(result.verification.status, "unavailable");
  } finally {
    r.close();
  }
});
test("actual sm-crypto SM3 vector, SM4 roundtrip, SM2 signature verification and captured exports", () => {
  const r = library("sm-crypto");
  try {
    const expected =
        "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0",
      w = r.api.command({
        action: "start",
        target: expected,
        match: "exact",
        count: 1,
        ttlMs: 1000,
      });
    assert.equal(r.run('lib.sm3("abc")'), expected);
    assert.equal(
      r.api.read({ watchId: w.watchId, limit: 10 }).entries[0].input,
      "abc",
    );
    assert.equal(
      r.run(
        'lib.sm4.decrypt(lib.sm4.encrypt("中文😀","0123456789abcdeffedcba9876543210"),"0123456789abcdeffedcba9876543210")',
      ),
      "中文😀",
    );
    assert.equal(
      r.run(
        '(()=>{const k=lib.sm2.generateKeyPairHex();const sign=lib.sm2.doSignature("fixture",k.privateKey);return lib.sm2.doVerifySignature("fixture",sign,k.publicKey);})()',
      ),
      true,
    );
    const rows = r.api.read({ limit: 100 }).entries;
    assert.ok(
      rows.some(
        (e: any) => e.algo === "sm-crypto.sm4.encrypt" && e.input === "中文😀",
      ),
    );
    assert.ok(
      rows.some(
        (e: any) =>
          e.algo === "sm-crypto.sm2.doSignature" &&
          e.input === "fixture" &&
          typeof e.key === "string",
      ),
    );
  } finally {
    r.close();
  }
});

test("real forge streaming SHA256, js-sha256 streaming and bounded regex/Base64 matching", () => {
  for (const name of ["node-forge", "js-sha256"]) {
    const r = library(name);
    try {
      const expected = createHash("sha256").update("abc").digest("hex");
      const w = r.api.command({
        action: "start",
        target: "^[0-9a-f]{64}$",
        match: "regex",
        count: 4,
        ttlMs: 1000,
      });
      const code =
        name === "node-forge"
          ? 'var d=lib.md.sha256.create();d.update("a");d.update("bc");d.digest().toHex()'
          : 'var d=lib.create();d.update("a");d.update("bc");d.hex()';
      assert.equal(r.run(code), expected);
      const rows = r.api.read({ watchId: w.watchId, limit: 100 }).entries;
      assert.ok(
        rows.some((e: any) => e.input === "abc" && e.streamId),
        name,
      );
      const b = r.api.command({
        action: "start",
        target: Buffer.from(expected, "hex").toString("base64"),
        match: "exact",
        count: 1,
        ttlMs: 1000,
      });
      r.run(
        name === "node-forge"
          ? 'lib.md.sha256.create().update("abc").digest()'
          : 'lib.sha256("abc")',
      );
      assert.equal(
        r.api.read({ watchId: b.watchId, limit: 10 }).entries.length,
        1,
      );
      assert.throws(
        () =>
          r.api.command({ action: "start", target: "(a+)+$", match: "regex" }),
        (e: any) => e.code === "REGEX_UNSUPPORTED",
      );
    } finally {
      r.close();
    }
  }
});
test("real aes-js CBC roundtrip and tweetnacl secretbox/sign capture", () => {
  const aes = library("aes-js");
  try {
    assert.equal(
      aes.run(
        "var key=new Uint8Array(16),iv=new Uint8Array(16),msg=new Uint8Array(16);msg[0]=42;var data=new lib.ModeOfOperation.cbc(key,iv).encrypt(msg);new lib.ModeOfOperation.cbc(key,iv).decrypt(data)[0]",
      ),
      42,
    );
    assert.ok(
      aes.api
        .read({ limit: 100 })
        .entries.some(
          (e: any) =>
            e.algo === "aes-js.cbc.encrypt" &&
            e.key?.bytes === 16 &&
            e.iv?.bytes === 16,
        ),
    );
  } finally {
    aes.close();
  }
  const nacl = library("tweetnacl");
  try {
    assert.equal(
      nacl.run(
        "var key=new Uint8Array(32),nonce=new Uint8Array(24),msg=new Uint8Array([1,2,3]);lib.secretbox.open(lib.secretbox(msg,nonce,key),nonce,key)[2]",
      ),
      3,
    );
    assert.equal(
      nacl.run(
        "var pair=lib.sign.keyPair.fromSeed(new Uint8Array(32));lib.sign.detached.verify(msg,lib.sign.detached(msg,pair.secretKey),pair.publicKey)",
      ),
      true,
    );
    assert.ok(
      nacl.api
        .read({ limit: 100 })
        .entries.some(
          (e: any) =>
            /secretbox$/.test(e.algo) &&
            e.key?.bytes === 32 &&
            e.iv?.bytes === 24,
        ),
    );
  } finally {
    nacl.close();
  }
});
test("real JSEncrypt RSA sign/verify observes the original result", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const r = library("jsencrypt");
  try {
    vm.runInContext(
      `var rsa=new lib();rsa.setPrivateKey(${JSON.stringify(pair.privateKey)});`,
      r.context,
    );
    const sig = r.run(
      'rsa.sign("abc",function(){return "900150983cd24fb0d6963f7d28e17f72"},"md5")',
    );
    assert.equal(typeof sig, "string");
    assert.ok(sig.length > 100);
    assert.equal(
      r.run(
        'rsa.verify("abc",rsa.sign("abc",function(){return "900150983cd24fb0d6963f7d28e17f72"},"md5"),function(){return "900150983cd24fb0d6963f7d28e17f72"})',
      ),
      true,
    );
    assert.ok(
      r.api
        .read({ limit: 100 })
        .entries.some(
          (e: any) =>
            e.algo === "JSEncrypt.sign" &&
            e.input === "abc" &&
            e.phase === "return",
        ),
    );
  } finally {
    r.close();
  }
});

test("pinned Date covers constructor and calls; execution TTL uses the host clock", async () => {
  const c = vm.createContext({ setTimeout, clearTimeout });
  installBootAnalysis(c, {
    enabled: true,
    now: 1700000000000,
    randomSeed: 42,
    ttlMs: 1000,
    execution: { enabled: true },
  });
  try {
    assert.equal(vm.runInContext("new Date().getTime()", c), 1700000000000);
    assert.equal(vm.runInContext("new Date(0).getTime()", c), 0);
    assert.equal(vm.runInContext("new Date().constructor === Date", c), true);
    vm.runInContext(
      '__wxappExecutionV1.command({action:"start",ttlMs:100,maxEvents:100})',
      c,
    );
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(
      vm.runInContext(
        '__wxappExecutionV1.command({action:"status"}).active.reason',
        c,
      ),
      "ttl",
    );
  } finally {
    vm.runInContext('__wxappBootAnalysisV1.command({action:"stop"})', c);
  }
  assert.ok(vm.runInContext("Date.now()", c) > 1700000000000);
});

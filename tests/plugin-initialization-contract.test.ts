import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

// Evidence test for the actual 3.17.3 JS entry points. Dependencies are explicit
// test doubles, not successful native responses or a substitute for a full boot.
const source = fs.readFileSync(new URL("../../baselib/WAServiceMainContext.js", import.meta.url), "utf8");
assert.equal(crypto.createHash("sha256").update(source).digest("hex"), "875dd20bc4936f37bd9443c4e9e5ea170dd88a95a9712c3898c45868509c0d28", "Re-anchor the official plugin initialization evidence for a new base library");
const traverse = (traverseModule as any).default || traverseModule;
const callbacks: string[] = [],
  verifiers: string[] = [];
traverse(parse(source, {
  sourceType: "script"
}), {
  CallExpression(p: any) {
    const n = p.node;
    if (n.callee.type !== "MemberExpression" || n.callee.property.name !== "onReady") return;
    const arg = n.arguments[0];
    if (!arg || arg.type !== "ArrowFunctionExpression") return;
    const text = source.slice(arg.start, arg.end);
    if (text.includes('"start to invokeGetPluginList"')) callbacks.push(text);
  },
  VariableDeclarator(p: any) {
    const n = p.node;
    if (n.id.name !== "AG" || n.init?.type !== "ArrowFunctionExpression") return;
    const text = source.slice(n.init.start, n.init.end);
    if (text.includes('"start to invokeVerifyPlugin "')) verifiers.push(text);
  }
});
assert.equal(callbacks.length, 1);
assert.equal(verifiers.length, 1);
function observe(config: any) {
  const native: any[] = [],
    phases: any[] = [],
    messages: string[] = [];
  const context = vm.createContext({
    j: {
      Ay: config
    },
    sG: {},
    gG: false,
    mG: [],
    // Factory normalization and semver conversion are outside these assertions;
    // the real callback still selects the metadata and inner_version itself.
    f_: (data: any) => data,
    c_: () => 0,
    _: {
      getEnv: () => ({
        setPluginCompatible: (id: string) => phases.push(["compatible", id])
      })
    },
    PG: () => {
      throw Error("Unexpected deferred plugin in this fixture");
    },
    fG: (phase: number) => phases.push(["metadata", phase]),
    wG: (batch: number) => phases.push(["contact-fetch", batch]),
    iG: (message: string) => messages.push(message),
    kG: false,
    U: {
      k9: (name: string, options: any) => native.push({
        name,
        data: options.data
      })
    },
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  vm.runInContext(`var AG=(${verifiers[0]});var CG=()=>AG();(${callbacks[0]})();`, context, {
    timeout: 1000
  });
  return JSON.parse(JSON.stringify({
    native,
    phases,
    messages,
    pluginInfos: context.sG
  }));
}
const provider = "wx" + "0000000000000006";
const plugins = {
  example: {
    provider,
    version: "1.2.3",
    subpackage: "__APP__"
  }
};
test("original SDK requests verification during initialization, before business input", () => {
  const observed = observe({
    plugins
  });
  assert.deepEqual(observed.native, [{
    name: "verifyPlugin",
    data: {
      plugins: [{
        provider,
        inner_version: 0
      }]
    }
  }]);
  assert.deepEqual(observed.phases, [["metadata", 1], ["contact-fetch", 5]]);
});
test("contact inner_version replaces zero but does not suppress original SDK verification", () => {
  const observed = observe({
    plugins,
    appContactInfo: {
      call_plugin_info: [{
        plugin_id: provider,
        inner_version: 73,
        plugin_version: 10203,
        glass_easel_compatible: true
      }]
    }
  });
  assert.deepEqual(observed.native, [{
    name: "verifyPlugin",
    data: {
      plugins: [{
        provider,
        inner_version: 73
      }]
    }
  }]);
  assert.equal(observed.pluginInfos[provider].specifiedVersion, "1.2.3");
  assert.deepEqual(observed.phases, [["compatible", provider], ["metadata", 1], ["contact-fetch", 5]]);
});
test("original SDK skips the native verifier when no plugin was declared", () => {
  const observed = observe({});
  assert.deepEqual(observed.native, []);
  assert.ok(observed.messages.includes("plugins is empty, skip invokeVerifyPlugin."));
});
test("an empty contact array masks declared plugins; it is not a valid verification fix", () => {
  const observed = observe({
    plugins,
    appContactInfo: {
      call_plugin_info: []
    }
  });
  assert.deepEqual(observed.pluginInfos, {});
  assert.deepEqual(observed.native, []);
});

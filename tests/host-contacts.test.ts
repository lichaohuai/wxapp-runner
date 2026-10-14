import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostContactStore, prepareHostContacts, validateHostContacts } from "../src/loader/contacts";
import { readConfig, wxConfig } from "../src/config";
import { parseTool } from "../src/mcp/tools";
const appid = "wx" + "0000000000000001",
  provider = "wx" + "0000000000000006",
  other = "wx" + "000000000000000a";
const config = {
  appid,
  appVersion: 8,
  app: {
    entryPagePath: "home.html",
    plugins: {
      example: {
        provider,
        version: "1.2.3"
      }
    }
  }
};
const timestamp = Date.parse("2026-01-01T00:00:00Z");
const fixture = () => ({
  format: 1,
  appid,
  appVersion: 8,
  capturedAt: "2025-12-31T00:00:00Z",
  expiresAt: "2026-01-02T00:00:00Z",
  appContactInfo: {
    name: "测试元数据",
    call_plugin_info: [{
      plugin_id: provider,
      inner_version: 73,
      plugin_version: 1002003,
      glass_easel_compatible: true
    }]
  },
  contactList: [provider, other].map(appId => ({
    appId,
    plugin_list: [{
      PluginNetWork: {
        RequestDomain: ["https://plugin.invalid"],
        WsRequestDomain: [],
        TCPDomain: []
      },
      last_version: {
        custom_version: "1.2.3"
      },
      untouched: "original host field"
    }]
  }))
});
const errorCode = (code: string) => (e: any) => e.code === code;
test("host snapshot keeps native field names, SDK boot metadata and independent repeated contact reads", () => {
  const input = fixture();
  const data = validateHostContacts(input, config, timestamp);
  const store = new HostContactStore({
    ...config,
    hostContacts: data
  }, () => timestamp);
  input.contactList[0].plugin_list[0].PluginNetWork.RequestDomain.push("https://changed.invalid");
  const result = store.batch({
    appIds: [other, provider]
  });
  assert.deepEqual(result.contactList.map((c: any) => c.appId), [other, provider]);
  result.contactList[1]!.plugin_list[0].PluginNetWork.RequestDomain.length = 0;
  assert.deepEqual(store.batch({
    appIds: [provider]
  }).contactList[0], fixture().contactList[0]);
  const c = wxConfig({
    ...config,
    hostContacts: data
  });
  assert.equal(c.appContactInfo.call_plugin_info[0].inner_version, 73);
  c.appContactInfo.call_plugin_info[0].inner_version = 1;
  assert.equal(data.appContactInfo!.call_plugin_info[0].inner_version, 73);
  assert.equal(store.snapshot().missingBootProviders.length, 0);
  assert.equal(store.snapshot().missingContacts.length, 0);
});
test("missing contacts fail the complete batch without partial success, fabricated versions or domains", () => {
  const missing = new HostContactStore(config);
  assert.throws(() => missing.batch({
    appIds: [provider]
  }), errorCode("HOST_CONTACTS_MISSING"));
  assert.deepEqual(missing.snapshot().lastError?.missingAppIds, [provider]);
  assert.equal(wxConfig(config).appContactInfo, undefined);
  const data = fixture();
  data.contactList.pop();
  const store = new HostContactStore({
    ...config,
    hostContacts: data
  }, () => timestamp);
  assert.throws(() => store.batch({
    appIds: [provider, other]
  }), errorCode("HOST_CONTACTS_MISSING"));
  assert.deepEqual(store.snapshot().lastError?.missingAppIds, [other]);
  assert.equal(store.batch({
    appIds: [provider]
  }).contactList.length, 1);
});
test("invalid batch parameters do not enter the contact lookup", () => {
  const store = new HostContactStore(config);
  for (const args of [{}, {
    appIds: []
  }, {
    appIds: [provider, provider]
  }, {
    appIds: "bad"
  }, {
    appIds: [1]
  }, {
    appIds: ["gh_bad"]
  }]) assert.throws(() => store.batch(args), errorCode("HOST_CONTACTS_INVALID_ARGUMENT"));
  assert.equal(store.snapshot().batchCalls, 0);
});
test("identity, internal version and incomplete boot list are validated without semver guessing", () => {
  const check = (patch: any, code = "HOST_CONTACTS_INVALID") => assert.throws(() => validateHostContacts({
    ...fixture(),
    ...patch
  }, config, timestamp), errorCode(code));
  check({
    appid: other
  }, "HOST_CONTACTS_IDENTITY_MISMATCH");
  check({
    appVersion: 9
  }, "HOST_CONTACTS_IDENTITY_MISMATCH");
  check({
    appVersion: 0
  });
  check({
    appContactInfo: {
      call_plugin_info: []
    }
  });
  check({
    appContactInfo: {
      call_plugin_info: [{
        plugin_id: provider,
        inner_version: "1.2.3"
      }]
    }
  });
  check({
    contactList: [fixture().contactList[0], fixture().contactList[0]]
  });
  check({
    contactList: [{
      appId: provider,
      plugin_list: [{
        PluginNetWork: {
          WsRequestDomain: "https://bad.invalid"
        }
      }]
    }]
  });
});
test("expiry is enforced on both boot and later native reads; caller mutation cannot extend it", () => {
  const data = fixture();
  let now = timestamp;
  const store = new HostContactStore({
    ...config,
    hostContacts: data
  }, () => now);
  now = Date.parse(data.expiresAt);
  data.expiresAt = "2030-01-01T00:00:00Z";
  assert.throws(() => store.batch({
    appIds: [provider]
  }), errorCode("HOST_CONTACTS_EXPIRED"));
  assert.equal(store.snapshot().state, "expired");
  assert.throws(() => validateHostContacts(fixture(), config, now), errorCode("HOST_CONTACTS_EXPIRED"));
});
test("file config, CLI and MCP select host data explicitly; preflight rejects a changed or oversized file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-host-contacts-"));
  try {
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify({
      ...config.app,
      pages: ["home"],
      appVersion: 8
    }));
    const file = path.join(dir, "contacts.json"),
      cfgFile = path.join(dir, "config.json");
    const data: any = fixture();
    delete data.expiresAt;
    fs.writeFileSync(file, JSON.stringify(data));
    fs.writeFileSync(cfgFile, JSON.stringify({
      contactsFile: "contacts.json"
    }));
    const args = ["--config", cfgFile, "--appid", appid, "--package", pkg];
    const c = readConfig(args);
    assert.equal(c.contactsFile, file);
    assert.equal(c.hostContacts!.appContactInfo!.call_plugin_info[0].inner_version, 73);
    assert.match(c.hostContactsProvenance!.sha256, /^[0-9a-f]{64}$/);
    const parsed = parseTool("runner_runtime", {
      action: "start",
      packageDir: pkg,
      contactsFile: file
    });
    assert.ok("contactsFile" in parsed);
    assert.equal(parsed.contactsFile, file);
    fs.writeFileSync(file, JSON.stringify({
      ...data,
      appVersion: 9
    }));
    assert.throws(() => prepareHostContacts(c), errorCode("HOST_CONTACTS_IDENTITY_MISMATCH"));
    fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => prepareHostContacts(c), errorCode("HOST_CONTACTS_INVALID"));
    fs.writeFileSync(file, JSON.stringify(data));
    fs.writeFileSync(cfgFile, "{}");
    assert.equal(readConfig([...args, "--contacts", file]).hostContacts!.appVersion, 8);
    assert.equal(readConfig(args).hostContacts, undefined);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});

import { ownContractFixture } from "./contract-lifecycle.mjs";
import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
export async function until(probe, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(r => setTimeout(r, 40));
  }
  throw Error("Condition timeout");
}
export async function managedFixture(options = {}) {
  const isolated = isolatedRuntime();
  const env = {
    ...isolated.env
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!options.standalone) delete env.WXAPP_STANDALONE;
  const pkg = options.packageDir || interactionFixture(isolated.directory, options.url || "http://127.0.0.1:1/unused");
  if (options.debug || options.config) fs.writeFileSync(path.join(isolated.directory, "config.json"), JSON.stringify({
    ...options.config,
    ...(options.debug ? {
      debug: options.debug
    } : {})
  }), {
    mode: 0o600
  });
  const connection = path.join(isolated.directory, "mcp.json");
  await options.beforeStart?.({
    isolated,
    packageDir: pkg
  });
  const launching = electron.launch({
    cwd: process.cwd(),
    env,
    args: [".", "--package", pkg, "--appid", options.appid || process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(), "--mcp", "--mcp-file", connection, ...isolated.args]
  });
  const disown = ownContractFixture(async () => {
    const owned = await launching.catch(() => null);
    await owned?.close();
    isolated.cleanup();
  });
  const app = await launching;
  const logs = [];
  app.process().stdout.on("data", b => logs.push(String(b)));
  app.process().stderr.on("data", b => logs.push(String(b)));
  // Electron launch returns before the loader's async ready hook has settled.
  // Explicitly cross that barrier instead of polling files while startup is idle.
  await app.evaluate(async ({
    app
  }) => {
    await app.whenReady();
  });
  const clients = [];
  async function newClient() {
    const c = new Client({
      name: "managed-regression",
      version: "1"
    });
    await c.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
      stderr: "pipe"
    }));
    clients.push(c);
    return c;
  }
  try {
    await until(() => fs.existsSync(connection));
  } catch (e) {
    console.error(logs.join("").slice(-6000));
    await app.close();
    isolated.cleanup();
    throw e;
  }
  const client = await newClient();
  const callAs = async (c, name, args = {}) => {
    const r = await c.callTool({
      name,
      arguments: args
    });
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const call = (name, args) => callAs(client, name, args);
  try {
    await until(async () => (s => s.serviceReady && s.current?.ready && s.current?.routed !== false)(await call("runner_status")));
  } catch (e) {
    console.error(logs.join("").slice(-6000));
    try {
      await options.onStartupFailure?.({
        app,
        client,
        call,
        logs,
        error: e
      });
    } finally {
      await client.close();
      await app.close();
      isolated.cleanup();
    }
    throw e;
  }
  return {
    app,
    client,
    call,
    callAs,
    newClient,
    isolated,
    connection,
    logs,
    close: async () => {
      for (const c of clients) await c.close();
      await app.close();
      isolated.cleanup();
      disown();
    }
  };
}

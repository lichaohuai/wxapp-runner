import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WxbotClient } from "../src/wxbot";
import { redact } from "../src/mcp/redact";
test("plugin verification has its own endpoint, preserves native JSON, rejects missing/empty/error results and never grants a domain", async () => {
  const provider = "wx" + "0000000000000006",
    appid = "wx" + "000000000000000a";
  let calls = 0,
    request: any,
    status = 200;
  let answer: any = {
    ok: true,
    ret: 0,
    json: JSON.stringify({
      list: [{
        plugin_id: provider,
        banning: 0,
        host_sign: "fixture-secret",
        request_domain: ["https://plugin.invalid"]
      }]
    })
  };
  const server = http.createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const c of req) body += c;
    request = {
      path: req.url,
      ...JSON.parse(body)
    };
    res.writeHead(status, {
      "Content-Type": "application/json"
    }).end(status === 404 ? "<html>Not Found</html>" : JSON.stringify(answer));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const client = new WxbotClient({
      appid,
      deviceId: "fixture",
      wxbot: `http://127.0.0.1:${(server.address() as any).port}`
    });
    const data = {
      plugins: [{
        provider,
        inner_version: 123
      }]
    };
    assert.deepEqual(await client.verifyPlugin(data), {
      data: answer.json
    });
    assert.equal(request.path, "/miniprogram/verifyplugin");
    assert.equal(request.appid, appid);
    assert.deepEqual(JSON.parse(request.data), data);
    assert.ok(!JSON.stringify(redact({
      data: answer.json
    })).includes("fixture-secret"));
    const before = calls;
    for (const bad of [{
      plugins: []
    }, {
      plugins: [{
        provider,
        inner_version: "1.11.5"
      }]
    }, {
      plugins: [...data.plugins, ...data.plugins]
    }]) await assert.rejects(client.verifyPlugin(bad));
    assert.equal(calls, before);
    answer = {
      ok: true,
      ret: 0,
      json: '{"list":[]}'
    };
    await assert.rejects(client.verifyPlugin(data), /no result/);
    answer = {
      ok: true,
      ret: 0,
      json: '{"err_no":-1,"list":[]}'
    };
    await assert.rejects(client.verifyPlugin(data), /err_no=-1/);
    status = 404;
    await assert.rejects(client.verifyPlugin(data), (e: any) => {
      assert.equal(e.runnerCode, "PLUGIN_VERIFY_ENDPOINT_UNAVAILABLE");
      assert.match(e.message, /does not establish/);
      assert.doesNotMatch(e.message, /deploy/i);
      return true;
    });
    assert.equal(calls, before + 3);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WxbotClient } from "../src/wxbot";
import { accountApi } from "../src/wx-shim/account";
import { redact } from "../src/mcp/redact";
test("mini-program contract serializes cloud function data and retains native operate envelope; inner failures are failures", async () => {
  let body: any,
    endpoint = "",
    answer: any = {
      ok: true,
      ret: 0,
      json: JSON.stringify({
        err_no: 0,
        data: JSON.stringify({
          baseresponse: { errcode: 0 },
          result: "fixture",
        }),
      }),
    };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw);
    endpoint = req.url!;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    wxbot: `http://127.0.0.1:${(server.address() as any).port}`,
    appid: "fixture",
    deviceId: "fixture-device",
  };
  try {
    const client = new WxbotClient(cfg);
    const operate = await client.operate({
      api_name: "qbase_commapi",
      data: { qbase_api_name: "function" },
    });
    assert.equal(typeof body.data, "string");
    assert.equal(operate.data, answer.json);
    const api = accountApi(cfg, () => {});
    await api.cloud.callFunction({
      name: "login",
      data: { text: "中文 😀" },
      config: { env: "explicit-fixture-env" },
    });
    assert.equal(endpoint, "/miniprogram/cloudfunction");
    assert.equal(body.function_name, "login");
    assert.deepEqual(JSON.parse(body.data), { text: "中文 😀" });
    assert.equal(body.name, undefined);
    assert.equal(body.env, "explicit-fixture-env");
    await assert.rejects(
      api.cloud.callFunction({ name: "login" }),
      (error: any) => /explicit config.env/.test(error.errMsg),
    );
    answer = {
      ok: true,
      ret: 0,
      json: JSON.stringify({ err_no: -12004, data: "{}" }),
    };
    await assert.rejects(
      client.operate({ api_name: "qbase_commapi" }),
      /err_no=-12004/,
    );
    answer = { ok: true, ret: 0, json: "invalid" };
    await assert.rejects(client.call("getuserinfo"), /malformed/);
    answer = { ok: true, ret: 0, json: "null" };
    await assert.rejects(client.call("getuserinfo"), /invalid business/);
    answer = { ok: true, ret: "-1", code: "fixture" };
    await assert.rejects(client.call("jslogin"), /rejected/);
    answer = null;
    await assert.rejects(client.call("jslogin"), /envelope/);
    const sdk = { database() {}, init() {} };
    assert.equal(accountApi(cfg, () => {}, sdk).cloud, sdk);
    answer = {
      ok: true,
      ret: 0,
      json: JSON.stringify({
        err_no: 0,
        data: JSON.stringify({ nickName: "测试" }),
        signature: "fixture-signature",
        encryptedData: "fixture",
        iv: "fixture",
      }),
    };
    const info = await api.getUserInfo();
    assert.equal(info.userInfo.nickName, "测试");
    const privateResult = redact({
      json: JSON.stringify({
        data: JSON.stringify({
          openid: "fixture",
          phoneNumber: "fixture",
          code: "fixture",
        }),
      }),
    });
    assert.ok(!JSON.stringify(privateResult).includes("fixture"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

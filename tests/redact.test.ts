import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/mcp/redact";
test("HTTP/2 pseudo-header paths redact credential query fields in entries and raw diagnostics", () => {
  const pathname =
    "/resource?signature=private&%69v=private&code=private&public=ok";
  const result = redact({
    headers: { ":path": pathname },
    entries: [{ name: ":path", value: pathname }],
    raw: ":method: GET\r\n:path: " + pathname + "\r\naccept: */*\r\n",
  });
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(result.headers[":path"].includes("public=ok"));
  assert.ok(result.raw.includes(":method: GET"));
  assert.ok(result.raw.includes("accept: */*"));
});
test("plugin host signatures are hidden in native headers, HAR and verification JSON", () => {
  const input = {
    headers: { "X-WECHAT-HOSTSIGN": '{"signature":"fixture-secret"}' },
    har: [{ name: "x-wechat-hostsign", value: "fixture-secret" }],
    raw: "POST / HTTP/1.1\r\nX-WECHAT-HOSTSIGN: fixture-secret\r\n",
    verification: {
      hostSign: { data: "fixture-secret" },
      host_sign: "fixture-secret",
    },
  };
  const safe = redact(input);
  assert.ok(!JSON.stringify(safe).includes("fixture-secret"));
  assert.equal(safe.headers["X-WECHAT-HOSTSIGN"], "[REDACTED]");
});
test("CDP/HAR headers, raw HTTP headers, websocket credentials and partial JSON are redacted", () => {
  const input = {
    headers: [
      { name: "Authorization", value: "Bearer private" },
      { name: "X-Public", value: "中文" },
    ],
    queryString: [{ name: "code", value: "private" }],
    headersText:
      "POST / HTTP/1.1\r\nAuthorization: Bearer private\r\nCookie: session=private\r\nAccept: */*\r\n",
    url: "wss://user:private@localhost/socket?token=private&message=hello",
    partial: '{"token":"private',
  };
  const result = redact(input);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(result.headers[1].value, "中文");
  assert.ok(result.headersText.includes("Accept: */*"));
  assert.ok(result.url.includes("message=hello"));
});
test("redaction does not invoke an array's own map property", () => {
  const value: any = [{ token: "private", nested: [{ password: "private" }] }];
  value.map = () => {
    throw Error("app method must not run");
  };
  value[0].nested.map = null;
  assert.deepEqual(redact(value), [
    { token: "[REDACTED]", nested: [{ password: "[REDACTED]" }] },
  ]);
});

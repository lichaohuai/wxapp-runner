import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJsonPreview } from "../src/json-preview";
import { queryNetwork } from "../src/analysis/network";
import { networkSchema } from "../src/analysis/schemas";

const inner = {
  baseresponse: {
    errcode: 0,
    stat: { qbase_cost_time: 144, func_exec_cost_time: 23 },
  },
  result: JSON.stringify({ message: "云函数中文🙂", token: "fixture-secret" }),
};
const envelope = {
  ok: true,
  ret: 0,
  json: JSON.stringify({ err_no: 0, data: JSON.stringify(inner) }),
};
const body = JSON.stringify(envelope);

test("nested cloud envelopes retain structure and report every decoded path without changing raw JSON", () => {
  const before = body;
  const r = decodeJsonPreview(body);
  assert.deepEqual(r.value, {
    ok: true,
    ret: 0,
    json: {
      err_no: 0,
      data: {
        ...inner,
        result: { message: "云函数中文🙂", token: "fixture-secret" },
      },
    },
  });
  assert.deepEqual(
    r.decoding.paths,
    ["/json", "/json/data", "/json/data/result"].map((path) => ({
      path,
      layers: 1,
    })),
  );
  assert.equal(r.decoding.complete, true);
  assert.equal(body, before);
  assert.equal(typeof JSON.parse(body).json, "string");
});

test("plain strings, scalar-looking IDs, malformed JSON and HTML are never coerced or executed", () => {
  const data = {
    id: "0001",
    bool: "false",
    nil: "null",
    number: "12345678901234567890",
    quoted: '"quoted"',
    bad: "{x:1}",
    html: "<img src=x onerror=alert(1)>",
    js: '{"x": (globalThis.pwned=true)}',
  };
  const r = decodeJsonPreview(JSON.stringify(data));
  assert.deepEqual(r.value, data);
  assert.equal(r.decoding.changed, false);
  assert.equal(decodeJsonPreview("<html>oops</html>").isJson, false);
  assert.equal(decodeJsonPreview('{"x":').isJson, false);
});

test("arrays, multiple quoted layers and special property names decode without prototype pollution", () => {
  const encoded = JSON.stringify(JSON.stringify({ nested: [1, 2] }));
  const r = decodeJsonPreview(
    `{"__proto__":"{\\"polluted\\":true}","a/b~c":[${JSON.stringify(encoded)}]}`,
  );
  assert.deepEqual((r.value as any)["a/b~c"][0], { nested: [1, 2] });
  assert.equal(Object.hasOwn(r.value as object, "__proto__"), true);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.value), Object.prototype);
  assert.deepEqual(r.decoding.paths[1], { path: "/a~1b~0c/0", layers: 2 });
});

test("input, parse, node, depth and string-layer limits explicitly leave unexpanded data", () => {
  for (const [key, value] of Object.entries({
    inputBytes: 1,
    parseBytes: body.length + 5,
    nodes: 2,
    depth: 1,
  })) {
    const r = decodeJsonPreview(body, { [key]: value });
    assert.equal(r.decoding.complete, false, key);
    assert.ok(r.decoding.limits.includes(key), key);
  }
  const nested = JSON.stringify({
    x: JSON.stringify(JSON.stringify({ ok: true })),
  });
  const r = decodeJsonPreview(nested, { stringLayers: 1 });
  assert.equal(r.decoding.complete, false);
  assert.deepEqual(r.value, JSON.parse(nested));
});

test("network detail adds a sanitized decoded view, preserves parsed/raw meanings and permits repeat reads", async () => {
  const record = {
    id: "fixture",
    responseBody: body,
    responseBodyEncoding: "text",
  };
  const call = async () => record;
  const args = networkSchema.parse({ id: "fixture" });
  const r = await queryNetwork(call, args);
  const preview = r.responseBodyPreview;
  assert.equal(preview.decoded.json.data.result.token, "[REDACTED]");
  assert.equal(preview.decoded.json.data.result.message, "云函数中文🙂");
  assert.equal(typeof preview.parsed.json, "string");
  assert.equal(typeof JSON.parse(r.responseBody).json, "string");
  assert.ok(!JSON.stringify(r).includes("fixture-secret"));
  assert.deepEqual(await queryNetwork(call, args), r);
  const raw = await queryNetwork(
    call,
    networkSchema.parse({ id: "fixture", revealSensitive: true }),
  );
  assert.equal(raw.responseBody, body);
  assert.equal(
    raw.responseBodyPreview.decoded.json.data.result.token,
    "fixture-secret",
  );
  assert.equal(record.responseBody, body);
});

test("truncated and binary network bodies are not partially decoded and summary remains compact", async () => {
  for (const extra of [
    { responseBodyTruncated: true },
    { responseBodyEncoding: "base64" },
  ]) {
    const r = await queryNetwork(
      async () => ({ id: "fixture", responseBody: body, ...extra }),
      networkSchema.parse({ id: "fixture" }),
    );
    assert.equal(r.responseBodyPreview.decoded, undefined);
  }
  const small = await queryNetwork(
    async () => ({ id: "fixture", responseBody: body }),
    networkSchema.parse({ id: "fixture", previewBytes: 128 }),
  );
  assert.equal(small.responseBodyPreview.truncated, true);
  assert.equal(small.responseBodyPreview.decoded, undefined);
  const summary = await queryNetwork(
    async () => [{ id: "fixture", responseBody: body }],
    networkSchema.parse({}),
  );
  assert.equal(summary[0].responseBodyPreview, undefined);
});

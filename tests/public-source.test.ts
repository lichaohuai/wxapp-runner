import test from "node:test";
import assert from "node:assert/strict";
import { inspectPublicText } from "../scripts/check-public-source.mjs";

test("publication guard rejects an AppID in code, docs, paths and JSON without printing its value", () => {
  const identifier = "wx" + "a".repeat(16);
  for (const text of [JSON.stringify({ appid: identifier }), `const example = "${identifier}";`, `package-${identifier}/index.js`, `# Open ${identifier}`]) {
    const result = inspectPublicText(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].code, "APP_ID_LITERAL");
    assert.ok(!JSON.stringify(result).includes(identifier));
  }
  assert.deepEqual(inspectPublicText('appid: "YOUR_APPID"'), []);
});

test("publication guard detects private-key markers and reports only location", () => {
  const marker = ["-----", "BEGIN PRIVATE KEY", "-----"].join("");
  assert.deepEqual(inspectPublicText("heading\n" + marker), [{ code: "PRIVATE_KEY_MATERIAL", line: 2 }]);
});

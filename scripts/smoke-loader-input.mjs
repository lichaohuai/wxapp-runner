import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-loader-input-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const file = path.join(pkg, "page-frame.html");
fs.writeFileSync(
  file,
  fs
    .readFileSync(file, "utf8")
    .replace("n('textarea'", "n('input'")
    .replace(
      "style:'padding:16px'",
      "style:'padding:16px;position:relative;z-index:100'",
    ),
);
const t = await managedFixture({ packageDir: pkg });
try {
  assert.equal(
    (await t.call("runner_wait", { kind: "element", selector: "wx-input" }))
      .status,
    "matched",
  );
  await t.call("runner_click", { selector: "wx-input" });
  assert.equal(
    (
      await t.call("runner_wait", {
        kind: "element",
        selector: "input[data-native-input]",
      })
    ).status,
    "matched",
  );
  await t.call("runner_input", {
    selector: "input[data-native-input]",
    text: "中文😀 native input",
  });
  const data = await t.call("runner_evaluate", {
    expression: "getCurrentPages()[0].data.input",
  });
  assert.equal(data.result.value, "中文😀 native input");
  const targetId = `page:${(await t.call("runner_status")).current.id}`;
  await t.call("runner_evaluate", {
    targetId,
    expression: "document.activeElement.blur();true",
  });
  await t.call("runner_wait", {
    kind: "hidden",
    selector: "input[data-native-input]",
  });
  // The real exparser control ignores a second focus attempt during its
  // focus transition. Observe that transition, rather than sleep/re-click.
  await until(
    async () =>
      (
        await t.call("runner_evaluate", {
          targetId,
          expression:
            "document.querySelector('wx-input').__wxElement._focusing !== true",
        })
      ).result.value,
  );

  await t.call("runner_click", { selector: "wx-input" });
  await t.call("runner_wait", {
    kind: "element",
    selector: "input[data-native-input]",
  });
  await t.call("runner_input", {
    selector: "input[data-native-input]",
    text: "失焦后重新输入😀",
  });
  assert.equal(
    (
      await t.call("runner_evaluate", {
        expression: "getCurrentPages()[0].data.input",
      })
    ).result.value,
    "失焦后重新输入😀",
  );
  const result = await t.client.callTool({
    name: "runner_screenshot",
    arguments: {},
  });
  const image = result.content.find((c) => c.type === "image");
  assert.ok(image);
  const p = PNG.sync.read(Buffer.from(image.data, "base64"));
  let colored = 0;
  for (let i = 0; i < p.data.length; i += 4)
    if (p.data[i] < 240 || p.data[i + 1] < 240 || p.data[i + 2] < 240)
      colored++;
  assert.ok(
    colored > 1000,
    "default screenshot must contain actual page pixels",
  );
  const report = {
    passed: true,
    platform: process.platform,
    exparserInputOriginalHandler: true,
    blurAndRefocusOriginalHandler: true,
    unicode: true,
    defaultScreenshotNonblank: true,
  };
  fs.writeFileSync(
    "docs/loader-input-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
} finally {
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

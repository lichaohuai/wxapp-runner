import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModuleSource } from "../src/analysis/source";
test("module symbol graph records literal dependencies and actual syntactic sites with pagination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-symbols-"));
  try {
    fs.writeFileSync(
      path.join(root, "app-service.js"),
      'define("utils/a.js",function(require,module,exports){const md5=require("utils/md5.js");exports.sign=function(x){return md5(x);};});\ndefine("utils/md5.js",function(require,module,exports){module.exports=function(x){return x;};});',
    );
    const source = new ModuleSource();
    const a = source.query(root, { action: "graph", offset: 0, limit: 1 });
    assert.equal(a.nodes.length, 1);
    assert.equal(a.hasMore, true);
    assert.equal(a.nodes[0].imports[0].module, "utils/md5.js");
    assert.equal(a.nodes[0].exports[0].name, "sign");
    assert.ok(a.nodes[0].calls.some((c: any) => c.expression === "md5"));
    assert.ok(a.nodes[0].imports[0].column > 1);
    const b = source.query(root, {
      action: "graph",
      offset: a.nextOffset,
      limit: 1,
    });
    assert.equal(b.nodes[0].exports[0].name, "default");
    assert.equal(b.hasMore, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

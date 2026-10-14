import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readableModule } from "../src/analysis/deobfuscate";
const evaluate = (s: string) => vm.runInNewContext(s)();
test("static passes preserve outputs, hoisted declarations, aliases and dynamic scope", () => {
  for (const source of [
    'function(){var t=["a","b"];return t[0]+t[1]+(2*3)}',
    "function(){if(false){var x=1}return typeof x}",
    'function(){if(false)var t=["a"];try{return t[0]}catch(e){return e.name}}',
    'function(){var t=["a"];var alias=t;alias[0]="b";return t[0]}',
    'function(){var t=["a"];eval("t[0]=\\"b\\"");return t[0]}',
    'function(){var order=["a","b"],i=0,out="";while(true){switch(order[i++]){case "a":out+="x";continue;case "b":out+="y";continue;}break;}return out+i;}',
  ]) {
    const r = readableModule(source);
    assert.equal(evaluate("(" + source + ")"), evaluate(r.source), source);
    assert.ok(r.map);
  }
  const r = readableModule(
    'function(){var t=["a","b"];return t[0]+t[1]+(2*3)}',
  );
  assert.ok(r.passes.some((x) => x.pass === "literal-table-inline"));
  assert.ok(r.passes.some((x) => x.pass === "constant-fold"));
});

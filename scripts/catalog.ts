import { buildCatalog } from '../src/suite/catalog';
import fs from 'node:fs';
import path from 'node:path';
const result = buildCatalog({
  packageDir: path.resolve(process.argv[2] || "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  baselibDir: path.resolve('../baselib'),
  sourceDir: path.resolve('../miniprogram-demo-source/miniprogram')
});
fs.writeFileSync('docs/official-demo-catalog.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  pages: result.pageCount,
  modules: result.pages.filter(p => p.apiInventory.file).length,
  controls: result.pages.reduce((n, p) => n + p.controls.length, 0),
  scanErrors: result.scanErrors
}));

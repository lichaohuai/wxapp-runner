import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as zlib from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeArchive, unpackArchive } from '../src/packages/archive';
import { PackageManager } from '../src/packages/manager';
import { parseTool } from '../src/mcp/tools';
function pack(entries: [string, string | Buffer][], count = entries.length) {
  const index = 4 + entries.reduce((n, [name]) => n + 12 + Buffer.byteLength(name), 0),
    body = entries.reduce((n, [, value]) => n + Buffer.byteLength(value), 0),
    out = Buffer.alloc(14 + index + body);
  out[0] = 0xbe;
  out[13] = 0xed;
  out.writeUInt32BE(index, 5);
  out.writeUInt32BE(body, 9);
  out.writeUInt32BE(count, 14);
  let at = 18,
    offset = 14 + index;
  for (const [name, value] of entries) {
    const n = Buffer.from(name),
      b = Buffer.from(value);
    out.writeUInt32BE(n.length, at);
    at += 4;
    n.copy(out, at);
    at += n.length;
    out.writeUInt32BE(offset, at);
    out.writeUInt32BE(b.length, at + 4);
    at += 8;
    b.copy(out, offset);
    offset += b.length;
  }
  return out;
}
test('CDN archive parser handles zstd, inaccurate count and identical duplicate indices without decryption', async () => {
  const plain = pack([['/中文.txt', '位置😀'], ['/same', '1'], ['/same', '1']], 99);
  const zstd = (zlib as any).zstdCompressSync(plain),
    decoded = await decodeArchive(zstd),
    r = unpackArchive(decoded);
  assert.equal(r.files.get('中文.txt')!.toString(), '位置😀');
  assert.equal(r.files.size, 2);
  assert.equal(r.warnings.length, 2);
  await assert.rejects(decodeArchive(Buffer.from('V1MMWXignored')), {
    code: 'ENCRYPTED_DISK_CACHE'
  });
  await assert.rejects(decodeArchive(zstd, 32));
  await assert.rejects(decodeArchive(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff])), {
    code: 'INVALID_ZSTD'
  });
});
test('CDN extraction rejects traversal, conflicting duplicates, corrupt bounds and file/directory ambiguity', () => {
  for (const name of ['/../outside', '/a/../b', '//absolute', 'C:/x', '/a\\b', '/a/CON', '/a/b.']) assert.throws(() => unpackArchive(pack([[name, 'x']])));
  for (const entries of [[['/a', 'x'], ['/a', 'y']], [['/a', 'x'], ['/A', 'x']], [['/a', 'x'], ['/a/b', 'y']], [['/a/b', 'x'], ['/a', 'y']]] as [string, string][][]) assert.throws(() => unpackArchive(pack(entries)));
  const b = pack([['/safe', 'x']]);
  b.writeUInt32BE(1, 18 + 4 + 5);
  assert.throws(() => unpackArchive(b));
  assert.throws(() => unpackArchive(pack([['/a', 'x']]).subarray(0, 22)));
});
test('MCP package identity validation rejects appid-only and ambiguous selections before any effect', () => {
  assert.throws(() => parseTool('runner_packages', {
    action: 'download',
    appid: "wx" + "0000000000000007",
    version: 7,
    expectedAppid: "wx" + "0000000000000001"
  }));
  for (const a of [{
    action: 'download',
    appid: "wx" + "0000000000000007"
  }, {
    action: 'download',
    keyword: "wx" + "0000000000000007"
  }, {
    action: 'download',
    keyword: '名字',
    appid: "wx" + "0000000000000007",
    version: 1
  }, {
    action: 'cancel'
  }, {
    action: 'download',
    keyword: '名字',
    concurrency: 0
  }]) assert.throws(() => parseTool('runner_packages', a));
  assert.doesNotThrow(() => parseTool('runner_packages', {
    action: 'download',
    keyword: '名字',
    expectedAppid: "wx" + "0000000000000007"
  }));
  assert.doesNotThrow(() => parseTool('runner_click', {
    x: 3,
    y: 4
  }));
});
const appid = "wx" + "0000000000000007";
async function fixture(options: {
  failSub?: boolean;
  stall?: boolean;
  shared?: 'same' | 'conflict';
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxapp-packages-')),
    calls: any[] = [],
    config = path.join(root, 'config.json');
  let base = '',
    active = 0,
    maxActive = 0;
  const main = pack([['/app-config.json', JSON.stringify({
    pages: ['pages/index/index'],
    entryPagePath: 'pages/index/index.html',
    subpackages: [{
      root: 'partA/'
    }, {
      root: 'partB/'
    }]
  })], ['/app-service.js', 'App({});Page({});'], ['/pages/index/index.html', '<body>fixture</body>']]);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({
      url: req.url,
      headers: req.headers,
      body
    });
    if (req.method === 'POST') {
      if (req.headers['x-app-key'] !== 'fixture-key' || req.headers['x-app-secret'] !== 'fixture-secret') {
        res.writeHead(401).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/mp/wxa/search') {
        res.end(JSON.stringify({
          ret: 0,
          accounts: [{
            title: '测试小程序',
            appid,
            desc: '中文描述😀'
          }],
          next_offset: 'next'
        }));
        return;
      }
      const module = body.module || '__APP__';
      res.end(JSON.stringify({
        ok: true,
        appid,
        version: 7,
        module,
        urls: module === '__APP__' ? [base + '/bad?token=private-signature', base + '/redirect'] : [base + (module === '/partA/' ? '/a' : '/b')]
      }));
      return;
    }
    if (req.url!.startsWith('/bad')) {
      res.end('not a package');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, {
        location: '/main.zstd?token=private-signature'
      }).end();
      return;
    }
    if (req.url!.startsWith('/main')) {
      if (!options.stall) res.end((zlib as any).zstdCompressSync(main));
      return;
    }
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active--;
    if (options.failSub && req.url === '/b') {
      res.writeHead(503).end();
      return;
    }
    res.end(req.url === '/a' ? pack([['/partA/page.html', '分包A'], ...(options.shared ? [['/shared/common.fpcssb', 'shared']] as [string, string][] : [])]) : options.shared ? pack([['/partB/page.html', '分包B'], ['/shared/common.fpcssb', options.shared === 'same' ? 'shared' : 'changed']]) : pack([['/page.html', '分包B']]));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  fs.writeFileSync(config, JSON.stringify({
    wxbot: base,
    appKey: 'fixture-key',
    appSecret: 'fixture-secret',
    deviceId: 'fixture-device'
  }));
  const manager = new PackageManager(path.join(root, 'cache'));
  const call = (args: any) => manager.dispatch(args, config);
  const until = async (fn: () => any) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await delay(5);
    }
    throw Error('Fixture condition timed out');
  };
  const finished = (id: string) => until(async () => {
    const r: any = await call({
      action: 'get',
      jobId: id
    });
    return r.status !== 'running' && r;
  });
  return {
    root,
    calls,
    call,
    manager,
    until,
    finished,
    maxActive: () => maxActive,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
      fs.rmSync(root, {
        recursive: true,
        force: true
      });
    }
  };
}
test('main-first + same-version parallel subpackages, zstd fallback, credential isolation, immutable cache and preflight', async () => {
  const f = await fixture();
  try {
    const s: any = await f.call({
      action: 'search',
      keyword: '测试小程序'
    });
    assert.equal(s.accounts[0].version, null);
    assert.equal(s.nextOffset, 'next');
    const resolved: any = await f.call({
      action: 'resolve',
      keyword: '测试小程序',
      expectedAppid: appid
    });
    assert.equal(resolved.version, 7);
    assert.equal(resolved.urls, undefined);
    const j: any = await f.call({
        action: 'download',
        keyword: '测试小程序',
        expectedAppid: appid
      }),
      duplicate: any = await f.call({
        action: 'download',
        keyword: '测试小程序',
        expectedAppid: appid
      });
    assert.equal(duplicate.jobId, j.jobId);
    const result = await f.finished(j.jobId);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.modules.length, 3);
    assert.equal(f.maxActive(), 2);
    assert.equal(fs.readFileSync(path.join(result.packageDir, 'partA/page.html'), 'utf8'), '分包A');
    assert.equal(fs.readFileSync(path.join(result.packageDir, 'partB/page.html'), 'utf8'), '分包B');
    const subCalls = f.calls.filter(c => c.body?.module);
    assert.deepEqual(subCalls.map(c => c.body.module).sort(), ['/partA/', '/partB/']);
    for (const c of subCalls) {
      assert.equal(c.body.appid, appid);
      assert.equal(c.body.version, 7);
      assert.equal(c.body.urls_only, '1');
      assert.equal(c.body.keyword, undefined);
    }
    assert.ok(f.calls.findIndex(c => c.url.startsWith('/main')) < f.calls.findIndex(c => c.body?.module));
    for (const c of f.calls.filter(c => !c.body)) {
      assert.equal(c.headers['x-app-key'], undefined);
      assert.equal(c.headers['x-app-secret'], undefined);
      assert.equal(c.headers.authorization, undefined);
    }
    const serialized = JSON.stringify(result);
    for (const secret of ['private-signature', 'fixture-secret', 'fixture-key']) assert.ok(!serialized.includes(secret));
    const before = f.calls.filter(c => !c.body).length,
      j2: any = await f.call({
        action: 'download',
        appid,
        version: 7
      });
    assert.equal((await f.finished(j2.jobId)).cacheHit, true);
    assert.equal(f.calls.filter(c => !c.body).length, before);
    const inspection: any = await f.call({
      action: 'inspect',
      appid,
      version: 7
    });
    assert.equal(inspection.integrity, 'verified');
    assert.equal(inspection.pages, 1);
    fs.writeFileSync(path.join(result.packageDir, 'partA/page.html'), 'corrupt');
    await assert.rejects(f.call({
      action: 'inspect',
      appid,
      version: 7
    }), {
      code: 'PACKAGE_CACHE_CORRUPT'
    });
  } finally {
    await f.close();
  }
});
test('keyword mismatch never fetches CDN content; subpackage failure never publishes partial package', async () => {
  const f = await fixture({
    failSub: true
  });
  try {
    const wrong: any = await f.call({
      action: 'download',
      keyword: '测试',
      expectedAppid: "wx" + "0000000000000001"
    });
    const failed = await f.finished(wrong.jobId);
    assert.equal(failed.error.code, 'PACKAGE_IDENTITY_MISMATCH');
    assert.equal(f.calls.filter(c => !c.body).length, 0);
    const j: any = await f.call({
        action: 'download',
        appid,
        version: 7
      }),
      r = await f.finished(j.jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'MODULE_DOWNLOAD_FAILED');
    assert.equal(((await f.call({
      action: 'list'
    })) as any).packages.length, 0);
    assert.deepEqual(r.modules.find((m: any) => m.module === '/partB/').attemptErrors, [{
      attempt: 1,
      code: 'CDN_HTTP',
      httpStatus: 503
    }]);
    assert.match(r.error.message, /CDN_HTTP 503/);
    assert.ok(!JSON.stringify(r).includes('private-signature'));
  } finally {
    await f.close();
  }
});
test('rooted subpackages preserve indexed app-global shared resources and deduplicate equal bytes', async () => {
  const f = await fixture({
    shared: 'same'
  });
  try {
    const j: any = await f.call({
        action: 'download',
        appid,
        version: 7
      }),
      r = await f.finished(j.jobId);
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(r.packageDir, 'shared/common.fpcssb'), 'utf8'), 'shared');
    assert.equal(fs.existsSync(path.join(r.packageDir, 'partA/shared/common.fpcssb')), false);
    assert.equal(fs.readFileSync(path.join(r.packageDir, 'partB/page.html'), 'utf8'), '分包B');
    assert.ok(r.modules.filter((m: any) => m.module !== '__APP__').every((m: any) => m.warnings.some((w: string) => w.includes('app-global'))));
  } finally {
    await f.close();
  }
});
test('conflicting shared resources in rooted subpackages still fail without publishing a partial package', async () => {
  const f = await fixture({
    shared: 'conflict'
  });
  try {
    const j: any = await f.call({
        action: 'download',
        appid,
        version: 7
      }),
      r = await f.finished(j.jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'PACKAGE_FILE_CONFLICT');
    assert.equal(((await f.call({
      action: 'list'
    })) as any).packages.length, 0);
  } finally {
    await f.close();
  }
});
test('explicit cancellation aborts an in-flight CDN response without publishing or replaying', async () => {
  const f = await fixture({
    stall: true
  });
  try {
    const j: any = await f.call({
      action: 'download',
      appid,
      version: 7
    });
    await f.until(() => f.calls.some(c => c.url.startsWith('/main')));
    await f.call({
      action: 'cancel',
      jobId: j.jobId
    });
    assert.equal((await f.finished(j.jobId)).status, 'cancelled');
    assert.equal(((await f.call({
      action: 'list'
    })) as any).packages.length, 0);
    assert.equal(f.calls.filter(c => c.url.startsWith('/main')).length, 1);
  } finally {
    await f.close();
  }
});
test('service recovery records interrupted jobs and never resumes them implicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxapp-package-recovery-'));
  try {
    fs.mkdirSync(path.join(root, 'jobs'), {
      recursive: true
    });
    const id = '12345678-1234-1234-1234-123456789012';
    fs.writeFileSync(path.join(root, 'jobs', id + '.json'), JSON.stringify({
      jobId: id,
      status: 'running',
      modules: []
    }));
    const m = new PackageManager(root);
    assert.equal(m.jobs.get(id)?.status, 'interrupted');
    assert.equal(m.jobs.get(id)?.error?.code, 'SERVICE_INTERRUPTED');
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  }
});

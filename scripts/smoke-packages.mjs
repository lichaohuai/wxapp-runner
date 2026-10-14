import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxapp-package-mcp-')),
  library = path.join(root, 'library'),
  config = path.join(root, 'config.json'),
  connection = path.join(root, 'connection.json'),
  appid = process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })();
const entries = [['/app-config.json', JSON.stringify({
  pages: ['pages/index'],
  entryPagePath: 'pages/index.html'
})], ['/app-service.js', 'App({});Page({})'], ['/pages/index.html', '<html>fixture</html>']];
const index = 4 + entries.reduce((n, [k]) => n + 12 + Buffer.byteLength(k), 0),
  body = entries.reduce((n, [, v]) => n + Buffer.byteLength(v), 0),
  archive = Buffer.alloc(14 + index + body);
archive[0] = 0xbe;
archive[13] = 0xed;
archive.writeUInt32BE(index, 5);
archive.writeUInt32BE(body, 9);
archive.writeUInt32BE(entries.length, 14);
let at = 18,
  offset = 14 + index;
for (const [name, value] of entries) {
  const n = Buffer.from(name),
    v = Buffer.from(value);
  archive.writeUInt32BE(n.length, at);
  at += 4;
  n.copy(archive, at);
  at += n.length;
  archive.writeUInt32BE(offset, at);
  archive.writeUInt32BE(v.length, at + 4);
  at += 8;
  v.copy(archive, offset);
  offset += v.length;
}
let base = '',
  downloads = 0;
const forwarded = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url === '/call') {
    forwarded.push(data.name);
    res.end(JSON.stringify({
      result: {
        runtimeId: 'original',
        sessionId: 'unchanged'
      }
    }));
    return;
  }
  if (req.url === '/client') {
    res.end('{}');
    return;
  }
  if (req.url === '/cdn') {
    assert.equal(req.headers['x-app-key'], undefined);
    assert.equal(req.headers['x-app-secret'], undefined);
    downloads++;
    await delay(100);
    res.end(archive);
    return;
  }
  assert.equal(req.headers['x-app-key'], 'fixture-key');
  assert.equal(req.headers['x-app-secret'], 'fixture-secret');
  if (req.url === '/mp/wxa/search') {
    res.end(JSON.stringify({
      ret: 0,
      accounts: [{
        appid,
        title: '搜索夹具'
      }]
    }));
    return;
  }
  assert.equal(data.urls_only, '1');
  res.end(JSON.stringify({
    ok: true,
    appid,
    version: 1,
    module: '__APP__',
    urls: [base + '/cdn']
  }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(config, JSON.stringify({
  wxbot: base,
  deviceId: 'fixture',
  appKey: 'fixture-key',
  appSecret: 'fixture-secret'
}));
fs.writeFileSync(connection, JSON.stringify({
  endpoint: base,
  token: 'fixture',
  version: 2
}));
const clients = [];
const connect = async () => {
  const c = new Client({
    name: 'packages-smoke',
    version: '1'
  });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/mcp.cjs'), '--connection', connection, '--package-config', config],
    env: {
      ...process.env,
      WXAPP_PACKAGE_LIBRARY: library
    },
    stderr: 'pipe'
  }));
  clients.push(c);
  return c;
};
const call = async (c, name, args = {}) => {
  const r = await c.callTool({
    name,
    arguments: args
  });
  if (r.isError) throw Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const until = async fn => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await delay(20);
  }
  throw Error('Condition timed out');
};
try {
  const [a, b] = await Promise.all([connect(), connect()]);
  assert.equal((await a.listTools()).tools.length, 36);
  assert.deepEqual(await call(a, 'runner_status'), {
    runtimeId: 'original',
    sessionId: 'unchanged'
  });
  const [search, empty] = await Promise.all([call(a, 'runner_packages', {
    action: 'search',
    keyword: '搜索夹具'
  }), call(b, 'runner_packages', {
    action: 'list'
  })]);
  assert.equal(search.accounts[0].appid, appid);
  assert.equal(empty.packages.length, 0);
  const [j, k] = await Promise.all([call(a, 'runner_packages', {
    action: 'download',
    appid,
    version: 1
  }), call(b, 'runner_packages', {
    action: 'download',
    appid,
    version: 1
  })]);
  assert.equal(j.jobId, k.jobId);
  const done = await until(async () => {
    const r = await call(b, 'runner_packages', {
      action: 'get',
      jobId: j.jobId
    });
    return r.status !== 'running' && r;
  });
  assert.equal(done.status, 'complete', JSON.stringify(done));
  assert.equal(downloads, 1);
  assert.equal((await call(a, 'runner_packages', {
    action: 'get',
    jobId: j.jobId
  })).packageDir, done.packageDir);
  const service = JSON.parse(fs.readFileSync(path.join(library, 'service.json')));
  assert.equal((await fetch(new URL('/health', service.endpoint))).status, 401);
  assert.equal(fs.statSync(path.join(library, 'service.json')).mode & 0o777, 0o600);
  await a.close();
  assert.equal((await call(b, 'runner_packages', {
    action: 'list'
  })).packages.length, 1);
  assert.deepEqual(await call(b, 'runner_status'), {
    runtimeId: 'original',
    sessionId: 'unchanged'
  });
  assert.deepEqual(forwarded, ['runner_status', 'runner_status']);
  const result = {
    passed: true,
    platform: process.platform,
    tools: 36,
    standardMcp: true,
    oldControllerCompatibility: true,
    sharedDaemon: true,
    multiClientSameJob: true,
    oneCdnDownload: true,
    clientDisconnectPreservesService: true,
    loopbackAuth: true,
    cdnCredentialsAbsent: true
  };
  fs.writeFileSync('docs/packages-mcp-result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  for (const c of clients) await c.close().catch(() => {});
  try {
    const c = JSON.parse(fs.readFileSync(path.join(library, 'service.json')));
    process.kill(c.pid, 'SIGTERM');
    await until(() => !fs.existsSync(path.join(library, 'service.json')));
  } catch {}
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  fs.rmSync(root, {
    recursive: true,
    force: true
  });
}

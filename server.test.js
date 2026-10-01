const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('测试状态未按预期完成');
}

test('多账号 HTTP 服务：隔离失败、后台更新、去重和删除', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-quota-test-'));
  const data = path.join(root, 'CodexQuotaMonitor');
  await fs.mkdir(data);
  const port = await freePort(), callbackPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const account = subject => ({ subject, accountId: subject, email: subject + '@example.com',
    authMode: 'codex', clientId: 'fake-client', accessToken: 'fake-private-access', refreshToken: 'fake-private-refresh',
    expiresAt: subject === 'expired' ? 0 : Date.now() + 3600000 });
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ port, proxyUrl: 'http://127.0.0.1:1' }));
  await fs.writeFile(path.join(data, 'accounts.json'), JSON.stringify({ accounts: ['healthy', 'flaky', 'expired'].map(account) }));
  const preload = path.join(root, 'mock.cjs');
  await fs.writeFile(preload, `
    if (${JSON.stringify(process.env.CODEX_QUOTA_TEST_PLATFORM === 'darwin')}) Object.defineProperty(process, 'platform', { value: 'darwin' });
    const adapter = require(${JSON.stringify(path.join(__dirname, 'openai.js'))});
    const proxy = require(${JSON.stringify(path.join(__dirname, 'proxy.js'))});
    let systemProxy = { mode: 'direct', httpProxy: '', httpsProxy: '', proxyUrl: '' };
    proxy.getSystemProxy = () => systemProxy;
    const http = require('node:http');
    const realListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(port, ...args) { return realListen.call(this, port === 1455 ? ${callbackPort} : port, ...args); };
    const realNow = Date.now;
    let offset = 0, timer, hold = false, release, holdExchange = false, releaseExchange, holdDetails = false, releaseDetails;
    Date.now = () => realNow() + offset;
    const realInterval = setInterval;
    global.setInterval = (fn, ms, ...args) => { if (ms === 300000) timer = fn; return realInterval(fn, ms, ...args); };
    process.on('message', msg => {
      if (msg.action === 'proxy') { systemProxy = { mode: 'system', httpProxy: 'http://127.0.0.1:8002', httpsProxy: 'http://127.0.0.1:8002', proxyUrl: 'http://127.0.0.1:8002' }; timer(); }
      if (msg.action === 'direct') { systemProxy = { mode: 'direct', httpProxy: '', httpsProxy: '', proxyUrl: '' }; timer(); }
      if (msg.action === 'tick') { offset += 300000; timer(); }
      if (msg.action === 'hold') hold = true;
      if (msg.action === 'holdExchange') holdExchange = true;
      if (msg.action === 'holdDetails') holdDetails = true;
      if (msg.action === 'release') { hold = false; release?.(); }
      if (msg.action === 'releaseExchange') { holdExchange = false; releaseExchange?.(); }
      if (msg.action === 'releaseDetails') { holdDetails = false; releaseDetails?.(); }
      process.send({ ack: msg.id });
    });
    const counts = new Map();
    adapter.readUsage = async account => {
      if (hold) await new Promise(resolve => { release = resolve; });
      const count = (counts.get(account.subject) || 0) + 1;
      counts.set(account.subject, count);
      if (account.subject === 'flaky' && count > 1) throw new adapter.OpenAIError('模拟临时查询失败', 503);
      return { planType: 'plus', short: { usedPercent: count, remainingPercent: 100 - count, windowMinutes: 300, resetAtMs: Date.now() + 18000000 }, long: null };
    };
    adapter.refreshTokens = async () => { throw new adapter.OpenAIError('模拟授权失效', 400, 'invalid_grant'); };
    const detailCounts = new Map();
    const detailCount = (account, key) => {
      const id = account.subject + '-' + key, count = (detailCounts.get(id) || 0) + 1;
      detailCounts.set(id, count); return count;
    };
    adapter.readResetCredits = async account => {
      if (holdDetails) await new Promise(resolve => { releaseDetails = resolve; });
      const count = detailCount(account, 'rewards');
      if (account.subject === 'flaky' && count === 1) throw new adapter.OpenAIError('奖励暂时限流', 429, 'rate_limit', Date.now() + 120000);
      return { availableCount: count, credits: [] };
    };
    adapter.readActivity = async account => ({ lifetimeTokens: detailCount(account, 'activity'), daily: [] });
    adapter.exchangeLogin = async (login, params) => {
      if (holdExchange) await new Promise(resolve => { releaseExchange = resolve; });
      const subject = params.get('code') === 'duplicate' ? 'healthy' : 'added';
      return { subject, accountId: subject, email: subject + '@example.com', authMode: 'codex', clientId: 'fake-client',
        accessToken: 'fake-new-private-access', refreshToken: 'fake-new-private-refresh', expiresAt: Date.now() + 3600000 };
    };
  `);
  const child = fork(path.join(__dirname, 'server.js'), [], { execArgv: ['--require', preload],
    env: { ...process.env, LOCALAPPDATA: root, HOME: root }, silent: true });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      // POSIX 的 SIGTERM 会执行服务清理；测试用 IPC 通道也必须关闭，进程才能退出。
      if (child.connected) child.disconnect();
      child.kill();
      await exited;
    }
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codex-quota-test-'))
      throw new Error('测试清理目录不匹配');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (chunk.toString().includes(origin)) resolve(); });
    child.once('exit', () => reject(new Error(stderr || '测试服务提前退出')));
  });
  let sequence = 0;
  function command(action) {
    const id = ++sequence;
    return new Promise(resolve => {
      const listener = msg => { if (msg.ack === id) { child.off('message', listener); resolve(); } };
      child.on('message', listener); child.send({ id, action });
    });
  }
  const status = () => fetch(origin + '/api/status').then(r => r.json());
  async function post(route, body = {}) {
    const response = await fetch(origin + '/api/' + route, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  function callback(url, code) {
    const params = new URLSearchParams({ state: new URL(url).searchParams.get('state'), code });
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: callbackPort, path: '/auth/callback?' + params,
        headers: { Host: 'localhost:1455' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
    });
  }
  const initial = await waitFor(async () => { const s = await status(); return !s.busy && s.accounts.every(a => a.status !== 'waiting') && s; });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(data)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(data, 'accounts.json'))).mode & 0o777, 0o600);
  }
  const healthy = initial.accounts.find(a => a.email.startsWith('healthy'));
  const flaky = initial.accounts.find(a => a.email.startsWith('flaky'));

  await t.test('账号迁移不丢失、前端不收到凭证、授权失效准确显示', () => {
    assert.equal(initial.accounts.length, 3);
    assert.ok(initial.accounts.every(a => a.id));
    assert.equal(initial.accounts.find(a => a.email.startsWith('expired')).status, 'needs_login');
    assert.equal(healthy.status, 'ok');
    assert.doesNotMatch(JSON.stringify(initial), /fake-private|accessToken|refreshToken|clientId|accountId/);
  });
  await t.test('按需查询奖励与活动，缓存成功结果，失败互不影响且尊重限流', async () => {
    const first = await post('details', { id: healthy.id });
    assert.equal(first.status, 200);
    assert.equal(first.data.rewards.data.availableCount, 1);
    assert.equal(first.data.activity.data.lifetimeTokens, 1);
    assert.deepEqual((await post('details', { id: healthy.id })).data, first.data);
    assert.doesNotMatch(JSON.stringify(first.data), /fake-private|accessToken|refreshToken|accountId/);
    const failed = await post('details', { id: flaky.id });
    assert.equal(failed.data.rewards.data, null);
    assert.equal(failed.data.rewards.error, '奖励暂时限流');
    assert.ok(failed.data.rewards.retryAt > Date.now());
    assert.equal(failed.data.activity.data.lifetimeTokens, 1);
    assert.deepEqual((await post('details', { id: flaky.id })).data, failed.data);
    assert.equal((await post('details', { id: 'missing' })).status, 400);
    assert.equal((await status()).accounts.find(a => a.id === flaky.id).status, 'ok');
    assert.equal((await fetch(origin + '/api/details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: healthy.id }) })).status, 403);
  });
  await t.test('5 分钟定时器触发更新，单个失败保留旧数据且不影响其他账号', async () => {
    await command('tick');
    const updated = await waitFor(async () => { const s = await status(); return !s.busy && s.accounts.find(a => a.id === healthy.id).checkedAt > healthy.checkedAt && s; });
    assert.ok(updated.nextRefreshAt > initial.nextRefreshAt);
    const failed = updated.accounts.find(a => a.id === flaky.id);
    assert.equal(failed.status, 'error');
    assert.equal(failed.checkedAt, flaky.checkedAt);
    assert.deepEqual(failed.usage, flaky.usage);
    assert.equal(updated.accounts.find(a => a.id === healthy.id).usage.short.usedPercent, 2);
  });
  await t.test('重复添加只更新原账号，新的身份添加独立条目', async () => {
    const duplicate = await post('login');
    assert.equal(await callback(duplicate.data.url, 'duplicate'), 303);
    const same = await status();
    assert.equal(same.accounts.length, 3);
    assert.equal(same.accounts.find(a => a.email.startsWith('healthy')).id, healthy.id);
    assert.equal((await post('details', { id: healthy.id })).data.activity.data.lifetimeTokens, 2);
    const added = await post('login');
    assert.equal(await callback(added.data.url, 'new'), 303);
    assert.equal((await status()).accounts.length, 4);
  });
  await t.test('拖动顺序持久保存，非法账号不改变列表和凭证', async () => {
    const before = await status(), last = before.accounts.at(-1);
    assert.equal((await post('reorder', { id: last.id, beforeId: healthy.id })).status, 200);
    const moved = await status();
    assert.equal(moved.accounts[0].id, last.id);
    const saved = JSON.parse(await fs.readFile(path.join(data, 'accounts.json'), 'utf8'));
    assert.deepEqual(saved.accounts.map(a => a.id), moved.accounts.map(a => a.id));
    assert.equal(saved.accounts.find(a => a.id === healthy.id).accessToken, 'fake-new-private-access');
    assert.equal((await post('reorder', { id: last.id, beforeId: 'unknown' })).status, 400);
    assert.equal((await post('reorder', { id: 'unknown', beforeId: null })).status, 400);
    assert.deepEqual((await status()).accounts.map(a => a.id), moved.accounts.map(a => a.id));
    assert.equal((await post('reorder', { id: last.id, beforeId: null })).status, 200);
    assert.equal((await status()).accounts.at(-1).id, last.id);
  });
  await t.test('每轮读取系统代理变化，移除手动代理 API 和旧配置字段', async () => {
    await command('proxy');
    await waitFor(async () => !(await status()).busy);
    assert.equal((await status()).proxyUrl, 'http://127.0.0.1:8002');
    await command('direct');
    await waitFor(async () => !(await status()).busy);
    assert.equal((await status()).proxyMode, 'direct');
    assert.equal((await status()).proxyUrl, '');
    assert.equal((await post('proxy', { proxyUrl: 'http://127.0.0.1:1' })).status, 404);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8')), { port });
  });
  await t.test('刷新期间拒绝删除，OAuth 回调等待刷新且保持操作锁', async () => {
    const started = await post('login');
    await command('hold'); await command('holdExchange');
    const refreshing = post('refresh');
    await waitFor(async () => (await status()).refreshing);
    assert.equal((await post('remove', { id: healthy.id })).status, 409);
    assert.equal((await post('reorder', { id: healthy.id, beforeId: null })).status, 409);
    const completing = callback(started.data.url, 'duplicate');
    await waitFor(async () => !(await status()).loggingIn);
    await command('release');
    assert.equal((await refreshing).status, 200);
    assert.equal((await status()).busy, true);
    assert.equal((await post('remove', { id: healthy.id })).status, 409);
    await command('releaseExchange');
    assert.equal(await completing, 303);
    assert.equal((await status()).busy, false);
  });
  await t.test('移除后不会被后续刷新恢复，磁盘和页面保持一致', async () => {
    assert.equal((await post('remove', { id: flaky.id })).status, 200);
    await command('tick');
    await waitFor(async () => !(await status()).busy);
    assert.ok(!(await status()).accounts.some(a => a.id === flaky.id));
    const saved = JSON.parse(await fs.readFile(path.join(data, 'accounts.json'), 'utf8'));
    assert.equal(saved.accounts.length, 3);
    assert.ok(!saved.accounts.some(a => a.id === flaky.id));
    assert.equal((await post('details', { id: flaky.id })).status, 400);
  });
  await t.test('详情缓存到期重新查询，读取期间保持删除锁', async () => {
    for (let index = 0; index < 3; index++) { await command('tick'); await waitFor(async () => !(await status()).busy); }
    assert.equal((await post('details', { id: healthy.id })).data.activity.data.lifetimeTokens, 3);
    const added = (await status()).accounts.find(a => a.email.startsWith('added'));
    await command('holdDetails');
    const pending = post('details', { id: added.id });
    await waitFor(async () => (await status()).busy);
    assert.equal((await post('remove', { id: added.id })).status, 409);
    await command('releaseDetails');
    assert.equal((await pending).status, 200);
    assert.ok((await status()).accounts.some(a => a.id === added.id));
  });
});

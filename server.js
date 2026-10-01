const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createLogin, exchangeLogin, refreshTokens, readUsage, readResetCredits, readActivity, OpenAIError } = require('./openai');
const { getSystemProxy } = require('./proxy');
const { dataDirectory, assertNodeVersion, configuredPort } = require('./runtime');

const REFRESH_MS = 5 * 60 * 1000;
const DETAILS_MS = 15 * 60 * 1000;
const dataDir = dataDirectory();
const stateFile = path.join(dataDir, 'accounts.json');
const configFile = path.join(dataDir, 'config.json');
const cache = new Map();
const detailsCache = new Map();
let config, state, origin, login, callbackServer, loginTimeout, refreshTimer;
let busy = false, refreshPromise = null, nextRefreshAt = 0, notice = null;
let proxy = {}, restoreProxy;

async function saveJson(file, value) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(`${file}.tmp`, 0o600);
  await fs.rename(`${file}.tmp`, file);
}
function save() { return saveJson(stateFile, state); }
async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function applyProxy() {
  const next = getSystemProxy();
  if (JSON.stringify(next) !== JSON.stringify(proxy)) {
    restoreProxy?.();
    restoreProxy = http.setGlobalProxyFromEnv({ http_proxy: next.httpProxy, https_proxy: next.httpsProxy,
      HTTP_PROXY: '', HTTPS_PROXY: '', no_proxy: 'localhost,127.0.0.1,::1', NO_PROXY: '' });
    proxy = next;
  }
}
async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2048) throw new OpenAIError('请求过大');
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new OpenAIError('请求格式无效'); }
}
function message(error) {
  return error instanceof OpenAIError ? error.message : '本机保存或处理失败，请检查文件权限';
}
function reply(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// 状态只选择展示字段；凭证和远端账号 ID 不进入页面。
function accountView(account) {
  const view = cache.get(account.id) || {};
  return { id: account.id, email: account.email, status: view.status || 'waiting',
    usage: view.usage || null, checkedAt: view.checkedAt || null,
    error: view.error || '', retryAt: view.retryAt || null };
}
async function renew(account) {
  try {
    Object.assign(account, await refreshTokens(account));
    await save();
  } catch (error) {
    if (error instanceof OpenAIError && (error.status === 401 ||
      ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'token_revoked'].includes(error.code)))
      throw new OpenAIError('授权已失效，请重新登录', 401, 'reauth_required');
    throw error;
  }
}
async function authorizedRead(account, read) {
  if (proxy.error) throw new OpenAIError(proxy.error);
  let renewed = false;
  if (account.expiresAt <= Date.now() + 60000) { await renew(account); renewed = true; }
  try { return await read(account); }
  catch (error) {
    if (error.status === 401 && renewed) throw new OpenAIError('授权已失效，请重新登录', 401, 'reauth_required');
    if (error.status !== 401 || Date.now() < account.earliestRefreshAt) throw error;
    await renew(account);
    try { return await read(account); }
    catch (retryError) {
      if (retryError.status === 401) throw new OpenAIError('授权已失效，请重新登录', 401, 'reauth_required');
      throw retryError;
    }
  }
}
async function refreshAccount(account) {
  const previous = cache.get(account.id) || {};
  if (previous.status === 'needs_login' || Date.now() < (previous.retryAt || 0)) return;
  cache.set(account.id, { ...previous, status: 'refreshing' });
  try {
    const usage = await authorizedRead(account, readUsage);
    cache.set(account.id, { status: 'ok', usage, checkedAt: Date.now() });
  } catch (error) {
    const needsLogin = error instanceof OpenAIError && error.code === 'reauth_required';
    cache.set(account.id, { ...previous, status: needsLogin ? 'needs_login' : 'error', error: message(error),
      retryAt: error.status === 429 ? (error.retryAt > Date.now() ? error.retryAt : Date.now() + REFRESH_MS) : 0 });
  }
}
async function readDetails(account) {
  applyProxy();
  const details = detailsCache.get(account.id) || {};
  for (const [key, read] of [['rewards', readResetCredits], ['activity', readActivity]]) {
    const previous = details[key];
    if (previous && (Date.now() < previous.retryAt || (!previous.error && Date.now() < previous.checkedAt + DETAILS_MS))) continue;
    try {
      const data = await authorizedRead(account, read);
      details[key] = { data, checkedAt: Date.now(), error: '', retryAt: 0 };
    } catch (error) {
      details[key] = { data: previous?.data || null, checkedAt: previous?.checkedAt || null, error: message(error),
        retryAt: error.status === 429 ? (error.retryAt > Date.now() ? error.retryAt : Date.now() + REFRESH_MS) : 0 };
      if (error.code === 'reauth_required') {
        cache.set(account.id, { ...cache.get(account.id), status: 'needs_login', error: message(error) });
        for (const other of ['rewards', 'activity']) if (other !== key)
          details[other] = { data: details[other]?.data || null, checkedAt: details[other]?.checkedAt || null, error: message(error), retryAt: 0 };
        break;
      }
    }
  }
  detailsCache.set(account.id, details);
  return details;
}
function refreshAll() {
  if (busy || refreshPromise) return refreshPromise || Promise.resolve();
  refreshPromise = (async () => {
    applyProxy();
    for (const account of state.accounts) await refreshAccount(account);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function cancelLogin() {
  login = null;
  clearTimeout(loginTimeout);
  callbackServer?.close();
  callbackServer = null;
}
async function beginLogin(target) {
  applyProxy();
  if (proxy.error) throw new OpenAIError(proxy.error);
  const pending = createLogin('http://localhost:1455/auth/callback', target);
  const listener = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, pending.redirectUri);
    if (request.method !== 'GET' || request.headers.host !== 'localhost:1455' || url.pathname !== '/auth/callback' ||
      !login || busy || Date.now() >= login.expiresAt || url.searchParams.get('state') !== login.state)
      return reply(response, { error: '登录回调不匹配，请重新发起登录' }, 400);
    busy = true;
    cancelLogin();
    try {
      // 回调可以在后台查询期间到达；等这一轮结束，避免同时轮换或保存凭证。
      await refreshPromise;
      applyProxy();
      if (proxy.error) throw new OpenAIError(proxy.error);
      const fresh = await exchangeLogin(pending, url.searchParams);
      if (target && (target.subject !== fresh.subject || (target.accountId && fresh.accountId && target.accountId !== fresh.accountId)))
        throw new OpenAIError('登录的是另一个账号，原账号凭证未替换');
      const existing = target || state.accounts.find(account => account.subject === fresh.subject && account.accountId === fresh.accountId);
      const account = { ...fresh, id: existing?.id || randomUUID() };
      if (existing) state.accounts[state.accounts.indexOf(existing)] = account;
      else state.accounts.push(account);
      await save();
      detailsCache.delete(account.id);
      cache.set(account.id, { ...(cache.get(account.id) || {}), status: 'waiting', error: '', retryAt: 0 });
      await refreshAccount(account);
      notice = { text: existing ? '账号授权已更新。' : '账号已添加。', at: Date.now(), error: false };
    } catch (error) { notice = { text: message(error), at: Date.now(), error: true }; }
    finally { busy = false; }
    response.writeHead(303, { Location: origin });
    response.end();
  });
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(1455, '127.0.0.1', resolve); });
  } catch {
    listener.close();
    throw new OpenAIError('登录回调端口 1455 无法监听，请关闭占用它的登录窗口后重试');
  }
  callbackServer = listener;
  login = pending;
  loginTimeout = setTimeout(cancelLogin, 600000).unref();
  return pending.url;
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!state) return reply(response, { error: '服务正在启动' }, 503);
  if (request.headers.host !== new URL(origin).host) return reply(response, { error: '本地地址不匹配' }, 403);
  const url = new URL(request.url, origin);
  const mutating = request.method === 'POST';
  let holdsBusy = mutating;
  if (mutating && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json'))
    return reply(response, { error: '请求必须来自本地页面' }, 403);
  if (mutating && (busy || refreshPromise || (login && !['/api/cancel', '/api/refresh'].includes(url.pathname))))
    return reply(response, { error: '正在登录或刷新，请稍后再试' }, 409);
  if (mutating) busy = true;
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(html);
    }
    if (request.method === 'GET' && url.pathname === '/api/status')
      return reply(response, { proxyUrl: proxy.proxyUrl, proxyMode: proxy.mode, proxyError: proxy.error || '', accounts: state.accounts.map(accountView),
        busy: Boolean(busy || refreshPromise), refreshing: Boolean(refreshPromise), loggingIn: Boolean(login), nextRefreshAt, notice });
    if (mutating) {
      const input = await readInput(request);
      if (url.pathname === '/api/details') {
        const account = state.accounts.find(account => account.id === input.id);
        if (!account) throw new OpenAIError('账号不存在');
        if (cache.get(account.id)?.status === 'needs_login') throw new OpenAIError('授权已失效，请重新登录');
        return reply(response, await readDetails(account));
      }
      if (url.pathname === '/api/reorder') {
        const account = state.accounts.find(account => account.id === input.id);
        if (!account || (input.beforeId !== null && !state.accounts.some(account => account.id === input.beforeId)))
          throw new OpenAIError('账号列表已变化，请刷新后重新排序');
        if (input.beforeId !== input.id) {
          const previous = state.accounts;
          const ordered = previous.filter(item => item !== account);
          ordered.splice(input.beforeId === null ? ordered.length : ordered.findIndex(item => item.id === input.beforeId), 0, account);
          state.accounts = ordered;
          try { await save(); } catch (error) { state.accounts = previous; throw error; }
        }
        return reply(response, { ok: true });
      }
      if (url.pathname === '/api/login') {
        const target = input.id ? state.accounts.find(account => account.id === input.id) : undefined;
        if (input.id && !target) throw new OpenAIError('账号不存在');
        return reply(response, { url: await beginLogin(target) });
      }
      if (url.pathname === '/api/cancel') { cancelLogin(); return reply(response, { ok: true }); }
      if (url.pathname === '/api/remove') {
        const index = state.accounts.findIndex(account => account.id === input.id);
        if (index < 0) throw new OpenAIError('账号不存在');
        const [account] = state.accounts.splice(index, 1);
        try { await save(); } catch (error) { state.accounts.splice(index, 0, account); throw error; }
        cache.delete(account.id);
        detailsCache.delete(account.id);
        return reply(response, { ok: true });
      }
      if (url.pathname === '/api/refresh') {
        busy = false;
        holdsBusy = false;
        await refreshAll();
        return reply(response, { ok: true });
      }
    }
    reply(response, { error: '未找到' }, 404);
  } catch (error) { reply(response, { error: message(error) }, 400); }
  finally { if (holdsBusy) busy = false; }
});
server.requestTimeout = 30000;

async function main() {
  assertNodeVersion();
  if (process.platform !== 'win32') process.umask(0o077);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('无法确认本机账号文件权限');
    execFileSync('icacls.exe', [dataDir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  } else await fs.chmod(dataDir, 0o700);
  config = await loadJson(configFile, { port: 17880 });
  config = { port: configuredPort(config) };
  origin = `http://127.0.0.1:${config.port}`;
  applyProxy();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  state = await loadJson(stateFile, { accounts: [] });
  if (!Array.isArray(state.accounts)) throw new Error('本机账号记录格式错误');
  for (const account of state.accounts) account.id ||= randomUUID();
  // 自动承接验证阶段的账号；不保存额度历史或旧的动态客户端 host ID。
  state = { accounts: state.accounts };
  await saveJson(configFile, config);
  await save();
  nextRefreshAt = Date.now() + REFRESH_MS;
  refreshTimer = setInterval(() => { nextRefreshAt = Date.now() + REFRESH_MS; void refreshAll(); }, REFRESH_MS);
  console.log(`Codex 额度监控：${origin}`);
  void refreshAll();
}
function stop() {
  clearInterval(refreshTimer);
  cancelLogin();
  server.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
main().catch(error => {
  console.error(error.code === 'EADDRINUSE' ? '本地端口已被占用，请勿重复启动。' : '启动失败，请检查配置文件、目录权限和 Node.js 版本。');
  stop();
  process.exitCode = 1;
});

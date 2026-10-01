const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { createLogin, exchangeLogin, verifyIdentity, normalizeUsage, refreshTokens, readUsage } = require('./openai');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' }];
const now = Date.now();
const claims = { iss: 'https://auth.openai.com', sub: 'user-1', aud: 'client-1', nonce: 'nonce-1',
  iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, email: 'test@example.com' };
function jwt(payload, header = { alg: 'RS256', kid: 'test' }) {
  const data = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
function mockResponse(data, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(data) }; }

test('Codex 登录保持 PKCE，重新申请正确客户端授权，不复用 SIWC client ID', () => {
  const a = createLogin('http://localhost:1455/auth/callback');
  const b = createLogin(a.redirectUri, { clientId: 'old-siwc-client', email: 'test@example.com', subject: 'user-1', accessToken: 'fake-secret' });
  const params = new URL(a.url).searchParams;
  assert.notEqual(a.state, b.state);
  assert.equal(params.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(new URL(a.url).pathname, '/oauth/authorize');
  assert.equal(params.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(new URL(b.url).searchParams.get('client_id'), params.get('client_id'));
  assert.equal(params.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(b.previousSubject, undefined);
  assert.ok(!params.has('resource'));
  assert.ok(!b.url.includes('fake-secret'));
  assert.ok(!new URL(b.url).searchParams.has('id_token_hint'));
});

test('ID Token 校验签名、身份、nonce、audience 和到期时间', () => {
  assert.equal(verifyIdentity(jwt(claims), keys, 'client-1', 'nonce-1', now).subject, 'user-1');
  for (const change of [{ iss: 'https://example.com' }, { aud: 'other-client' }, { nonce: 'wrong' },
    { exp: Math.floor(now / 1000) - 10 }, { iat: Math.floor(now / 1000) + 60 },
    { sub: '' }, { azp: 'other-client' }]) {
    assert.throws(() => verifyIdentity(jwt({ ...claims, ...change }), keys, 'client-1', 'nonce-1', now));
  }
  assert.throws(() => verifyIdentity(jwt(claims, { alg: 'none', kid: 'test' }), keys, 'client-1', 'nonce-1', now));
  const parts = jwt(claims).split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'tampered' })).toString('base64url');
  assert.throws(() => verifyIdentity(parts.join('.'), keys, 'client-1', 'nonce-1', now));
});

test('无效 state 和过期尝试不会兑换 code', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('不应访问网络'); });
  const login = createLogin('http://localhost:1455/auth/callback');
  await assert.rejects(exchangeLogin(login, new URLSearchParams({ state: 'wrong', code: 'fake' })));
  await assert.rejects(exchangeLogin({ ...login, expiresAt: 0 }, new URLSearchParams({ state: login.state, code: 'fake' })));
  assert.equal(mock.mock.callCount(), 0);
});

test('兑换 Codex 授权，校验身份，并只从签名身份字段取账号 ID', async t => {
  const login = createLogin('http://localhost:1455/auth/callback');
  const idToken = jwt({ ...claims, aud: login.clientId, nonce: login.nonce,
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' } });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/jwks.json')) return mockResponse({ keys });
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(options.body.get('code_verifier'), login.verifier);
    assert.equal(options.body.get('redirect_uri'), login.redirectUri);
    assert.ok(!options.body.has('resource'));
    return mockResponse({ id_token: idToken, access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 });
  });
  const params = new URLSearchParams({ state: login.state, code: 'fake-code' });
  const account = await exchangeLogin(login, params);
  assert.equal(account.authMode, 'codex');
  assert.equal(account.accountId, 'account-123');
  assert.equal(account.email, claims.email);
  await assert.rejects(exchangeLogin({ ...login, previousSubject: 'another-user' }, params), /另一个账号/);
});

test('窗口缺失不变成零额度，时间由秒转换为毫秒', () => {
  const result = normalizeUsage({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1790800000 } } });
  assert.equal(result.short.remainingPercent, 75);
  assert.equal(result.short.windowMinutes, 300);
  assert.equal(result.short.resetAtMs, 1790800000000);
  assert.equal(result.long, null);
  assert.equal(normalizeUsage({ rate_limit: { primary_window: {} } }).short.usedPercent, null);
  assert.throws(() => normalizeUsage({ changed_structure: true }));
});

test('Pro 单周窗口不误认为短周期，不虚构 5 小时额度', () => {
  const weekly = { used_percent: 18, limit_window_seconds: 604800, reset_at: 1790800000 };
  for (const rate_limit of [{ primary_window: weekly, secondary_window: null }, { primary_window: null, secondary_window: weekly }]) {
    const usage = normalizeUsage({ plan_type: 'pro', rate_limit });
    assert.equal(usage.planType, 'pro');
    assert.equal(usage.short, null);
    assert.equal(usage.long.windowMinutes, 10080);
    assert.equal(usage.long.remainingPercent, 82);
  }
  assert.deepEqual(normalizeUsage({ plan_type: 'pro', rate_limit: null }), { planType: 'pro', short: null, long: null });
});

test('窗口按返回的周期归类，不依赖主次字段位置或套餐名', () => {
  const short = { used_percent: 3, limit_window_seconds: 18000 }, long = { used_percent: 20, limit_window_seconds: 604800 };
  const reversed = normalizeUsage({ plan_type: 'pro', rate_limit: { primary_window: long, secondary_window: short } });
  assert.equal(reversed.short.windowMinutes, 300);
  assert.equal(reversed.long.windowMinutes, 10080);
  const single = normalizeUsage({ plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: short } });
  assert.equal(single.short.usedPercent, 3);
  assert.equal(single.long, null);
  assert.throws(() => normalizeUsage({ rate_limit: [] }), /不兼容/);
});

test('续期使用原 client ID，并替换旋转 Token', async t => {
  const account = { authMode: 'codex', clientId: 'client-1', subject: 'user-1', refreshToken: 'fake-old', scopes: ['offline_access'], earliestRefreshAt: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(options.body.get('client_id'), 'client-1');
    assert.equal(options.body.get('refresh_token'), 'fake-old');
    assert.ok(!options.body.has('scope'));
    assert.ok(!options.body.has('resource'));
    return mockResponse({ access_token: 'fake-access', refresh_token: 'fake-new', expires_in: 3600, token_type: 'Bearer' });
  });
  const next = await refreshTokens(account);
  assert.equal(next.refreshToken, 'fake-new');
  assert.equal(next.subject, 'user-1');
  assert.equal(account.refreshToken, 'fake-old');
  await assert.rejects(refreshTokens({ ...account, earliestRefreshAt: Date.now() + 600000 }), /尚未到/);
});

test('兼容省略 expires_in 的续期响应，额度请求附带账号路由', async t => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/oauth/token')) return mockResponse({ access_token: jwt({ exp: expires }) });
    assert.equal(options.headers['ChatGPT-Account-Id'], 'account-123');
    return mockResponse({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12 } } });
  });
  const account = await refreshTokens({ authMode: 'codex', clientId: 'client-1', accountId: 'account-123', refreshToken: 'fake-retained' });
  assert.equal(account.expiresAt, expires * 1000);
  assert.equal(account.refreshToken, 'fake-retained');
  assert.equal((await readUsage(account)).short.usedPercent, 12);
});

test('额度查询保留 HTTP 状态，不将远端原文泄露到错误说明', async t => {
  t.mock.method(globalThis, 'fetch', async () => mockResponse({ error: { code: 'permission_denied', message: 'fake-sensitive-text' } }, 403));
  await assert.rejects(readUsage({ accessToken: 'fake-access' }), error => error.status === 403 && !error.message.includes('fake-sensitive-text'));
});

test('网络错误区分连接重置，仍不泄露底层异常原文', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fake-sensitive-url', { cause: Object.assign(new Error('fake-sensitive-secret'), { code: 'ECONNRESET' }) });
  });
  await assert.rejects(readUsage({ accessToken: 'fake-access' }), error =>
    error.code === 'ECONNRESET' && error.message.includes('连接被重置') && !error.message.includes('fake-sensitive'));
});

test('429 响应保留 Retry-After 等待时间', async t => {
  const started = Date.now();
  t.mock.method(globalThis, 'fetch', async () => ({ ...mockResponse({ error: { code: 'rate_limit' } }, 429), headers: new Headers({ 'Retry-After': '120' }) }));
  await assert.rejects(readUsage({ accessToken: 'fake-access' }), error =>
    error.status === 429 && error.retryAt >= started + 120000 && error.retryAt <= Date.now() + 120000);
});

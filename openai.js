const { randomBytes, createHash, createPublicKey, verify } = require('node:crypto');

const ISSUER = 'https://auth.openai.com';
// Codex 客户端的兼容参数；不是承诺稳定的第三方 usage API。
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = `${ISSUER}/oauth/token`;
const SCOPE = 'openid profile email offline_access';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const ACTIVITY_URL = 'https://chatgpt.com/backend-api/wham/profiles/me';
let cachedKeys;

class OpenAIError extends Error {
  constructor(message, status = 0, code = '', retryAt = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...options.headers },
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!response.ok) {
      const rawCode = data?.error?.code || (typeof data?.error === 'string' ? data.error : '');
      const code = /^[a-z0-9_]{1,80}$/i.test(rawCode) ? rawCode : '';
      const retry = response.headers?.get('retry-after');
      const retryAt = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
      throw new OpenAIError(`远端请求返回 HTTP ${response.status}${code ? `（${code}）` : ''}`,
        response.status, code, Number.isFinite(retryAt) ? retryAt : 0);
    }
    if (!data || typeof data !== 'object') throw new OpenAIError('远端响应无法识别', response.status);
    return data;
  } catch (error) {
    if (error instanceof OpenAIError) throw error;
    // 只保留已知网络错误码，不输出可能包含凭证的底层异常原文。
    const rawCode = error.cause?.code || error.code;
    const messages = { ECONNREFUSED: '代理或目标连接被拒绝，请检查地址和端口',
      ECONNRESET: '网络连接被重置，请检查代理线路和规则',
      ENOTFOUND: '域名解析失败，请检查代理或 DNS',
      UND_ERR_CONNECT_TIMEOUT: '网络连接超时，请检查代理线路' };
    const code = Object.hasOwn(messages, rawCode) ? rawCode : '';
    throw new OpenAIError(error.name === 'TimeoutError' ? '网络请求超时，请检查代理线路' :
      (messages[code] || '网络请求失败，请检查代理或网络连接'), 0, code);
  }
}

function createLogin(redirectUri, account) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const clientId = CODEX_CLIENT_ID;
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPE, state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli',
  }).toString();
  if (account?.email) url.searchParams.set('login_hint', account.email);
  return { state, verifier, nonce, clientId, redirectUri,
    previousSubject: account?.clientId === clientId ? account.subject : undefined,
    expiresAt: Date.now() + 600000, url: url.toString() };
}

function verifyIdentity(token, keys, clientId, nonce, now = Date.now()) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const key = keys.find(key => key.kid === header.kid && key.kty === 'RSA' &&
      (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit || !key || !verify('RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'))) throw new Error();
    const seconds = now / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= seconds - 5 ||
      !Number.isFinite(claims.iat) || claims.iat > seconds + 5 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 5)) ||
      claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw new Error();
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '',
      accountId: typeof accountId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(accountId) ? accountId : '' };
  } catch {
    throw new OpenAIError('登录身份校验失败，请重新登录');
  }
}

async function exchangeLogin(login, params) {
  if (Date.now() >= login.expiresAt || params.get('state') !== login.state)
    throw new OpenAIError('登录已过期或回调不匹配');
  if (params.has('error')) throw new OpenAIError('登录被取消或授权未完成');
  const clientId = params.get('client_id') || login.clientId;
  if (!params.get('code') || clientId !== login.clientId)
    throw new OpenAIError('授权回调缺少有效 code 或 client ID');
  const tokens = await request(TOKEN_URL, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, code: params.get('code'),
    code_verifier: login.verifier, redirect_uri: login.redirectUri,
  }) });
  if (typeof tokens.id_token !== 'string') throw new OpenAIError('授权未返回身份信息');
  let keyId;
  try { keyId = JSON.parse(Buffer.from(tokens.id_token.split('.')[0], 'base64url')).kid; }
  catch { throw new OpenAIError('登录身份信息格式错误'); }
  if (!cachedKeys || !cachedKeys.some(key => key.kid === keyId)) {
    cachedKeys = (await request(`${ISSUER}/.well-known/jwks.json`)).keys;
    if (!Array.isArray(cachedKeys)) throw new OpenAIError('无法获取登录签名公钥');
  }
  const identity = verifyIdentity(tokens.id_token, cachedKeys, clientId, login.nonce);
  if (login.previousSubject && identity.subject !== login.previousSubject)
    throw new OpenAIError('登录的是另一个账号，原账号凭证未替换');
  return { clientId, authMode: 'codex', ...identity, ...tokenFields(tokens, { scopes: SCOPE.split(' ') }) };
}

function tokenFields(tokens, previous = {}) {
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token || previous.refreshToken;
  let expiresAt = Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? Date.now() + tokens.expires_in * 1000 : 0;
  // 某些 Codex 响应省略 expires_in；只把 access JWT 的 exp 用作续期时间提示。
  if (!expiresAt && typeof accessToken === 'string') {
    try { expiresAt = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).exp * 1000; } catch {}
  }
  if (typeof accessToken !== 'string' || !accessToken ||
    typeof refreshToken !== 'string' || !refreshToken ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
    (tokens.token_type !== undefined && (typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer')))
    throw new OpenAIError('授权未返回可续期的有效 Token');
  const rawEarliest = tokens.earliest_refresh_at;
  const numericEarliest = typeof rawEarliest === 'number' || (typeof rawEarliest === 'string' && /^\d+$/.test(rawEarliest)) ? Number(rawEarliest) : null;
  const earliestRefreshAt = numericEarliest !== null ? numericEarliest * (numericEarliest < 1e12 ? 1000 : 1) :
    (typeof rawEarliest === 'string' ? Date.parse(rawEarliest) : 0);
  return { accessToken, refreshToken, expiresAt,
    earliestRefreshAt: Number.isFinite(earliestRefreshAt) ? earliestRefreshAt : 0,
    scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : (previous.scopes || []) };
}

async function refreshTokens(account) {
  if (Date.now() < account.earliestRefreshAt)
    throw new OpenAIError('尚未到授权允许的续期时间，请稍后验证');
  const body = new URLSearchParams({
    grant_type: 'refresh_token', client_id: account.clientId,
    refresh_token: account.refreshToken,
  });
  const tokens = await request(TOKEN_URL, { method: 'POST', body });
  return { ...account, ...tokenFields(tokens, account) };
}

function normalizeUsage(body) {
  if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'rate_limit') ||
    (body.rate_limit !== null && (typeof body.rate_limit !== 'object' || Array.isArray(body.rate_limit))))
    throw new OpenAIError('额度接口字段暂不兼容', 200, 'unsupported_schema');
  const window = value => {
    if (!value || typeof value !== 'object') return null;
    const usedPercent = Number.isFinite(value.used_percent) && value.used_percent >= 0 && value.used_percent <= 100 ? value.used_percent : null;
    return { usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      windowMinutes: Number.isFinite(value.limit_window_seconds) && value.limit_window_seconds > 0 ? value.limit_window_seconds / 60 : null,
      resetAtMs: Number.isFinite(value.reset_at) && value.reset_at > 0 ? value.reset_at * 1000 : null };
  };
  let short = window(body.rate_limit?.primary_window), long = window(body.rate_limit?.secondary_window);
  // A sole weekly window may occupy primary_window; its position does not define its duration.
  if (short?.windowMinutes && long?.windowMinutes && short.windowMinutes > long.windowMinutes)
    [short, long] = [long, short];
  else if (!long && short?.windowMinutes >= 1440) [short, long] = [null, short];
  else if (!short && long?.windowMinutes > 0 && long.windowMinutes < 1440) [short, long] = [long, null];
  const resets = body.rate_limit_reset_credits;
  return { planType: typeof body.plan_type === 'string' ? body.plan_type : null, short, long,
    resetCredits: resets && typeof resets === 'object' ? {
      availableCount: count(resets.available_count), applicableAvailableCount: count(resets.applicable_available_count),
    } : null };
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function normalizeResetCredits(body) {
  if (!body || (!Array.isArray(body.credits) && count(body.available_count) === null))
    throw new OpenAIError('奖励接口字段暂不兼容', 200, 'unsupported_schema');
  return { availableCount: count(body.available_count), credits: Array.isArray(body.credits) ? body.credits
    .filter(credit => credit && typeof credit === 'object').map(credit => ({
      resetType: credit.reset_type === 'codex_rate_limits' ? 'codex_rate_limits' : 'unknown',
      status: ['available', 'redeeming', 'redeemed'].includes(credit.status) ? credit.status : 'unknown',
      supportedByPlan: typeof credit.is_supported_by_plan === 'boolean' ? credit.is_supported_by_plan : null,
      grantedAt: timestamp(credit.granted_at), expiresAt: timestamp(credit.expires_at),
      expiresKnown: credit.expires_at === null || timestamp(credit.expires_at) !== null,
      title: typeof credit.title === 'string' ? credit.title.slice(0, 200) : '',
      description: typeof credit.description === 'string' ? credit.description.slice(0, 400) : '',
    })) : null };
}
function normalizeActivity(body) {
  const stats = body?.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats))
    throw new OpenAIError('活动接口字段暂不兼容', 200, 'unsupported_schema');
  const amount = value => Number.isFinite(value) && value >= 0 ? value : null;
  const percentage = value => amount(value) !== null && value <= 100 ? value : null;
  // 仅向页面传递统计字段，排除远端身份、头像、会话与技能标识。
  const daily = new Map();
  if (Array.isArray(stats.daily_usage_buckets)) for (const bucket of stats.daily_usage_buckets) {
    if (bucket && /^\d{4}-\d{2}-\d{2}$/.test(bucket.start_date) && timestamp(bucket.start_date) && count(bucket.tokens) !== null)
      daily.set(bucket.start_date, { date: bucket.start_date, tokens: bucket.tokens });
  }
  return { lifetimeTokens: count(stats.lifetime_tokens), peakDailyTokens: count(stats.peak_daily_tokens),
    currentStreakDays: count(stats.current_streak_days), longestStreakDays: count(stats.longest_streak_days),
    longestRunningTurnSec: amount(stats.longest_running_turn_sec), totalThreads: count(stats.total_threads),
    fastModePercent: percentage(stats.fast_mode_usage_percentage), totalSkillsUsed: count(stats.total_skills_used),
    uniqueSkillsUsed: count(stats.unique_skills_used),
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(stats.most_used_reasoning_effort) ? stats.most_used_reasoning_effort : null,
    reasoningEffortPercent: percentage(stats.most_used_reasoning_effort_percentage),
    daily: Array.isArray(stats.daily_usage_buckets) ? [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14) : null,
    statsAsOf: timestamp(body.metadata?.stats_as_of), generatedAt: timestamp(body.metadata?.generated_at),
    partial: Boolean(body.metadata?.stats_error) };
}

async function accountRequest(url, account) {
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  if (account.accountId) headers['ChatGPT-Account-Id'] = account.accountId;
  return request(url, { headers });
}
async function readUsage(account) { return normalizeUsage(await accountRequest(USAGE_URL, account)); }
async function readResetCredits(account) { return normalizeResetCredits(await accountRequest(RESET_CREDITS_URL, account)); }
async function readActivity(account) { return normalizeActivity(await accountRequest(ACTIVITY_URL, account)); }

module.exports = { createLogin, exchangeLogin, refreshTokens, readUsage, readResetCredits, readActivity,
  verifyIdentity, normalizeUsage, normalizeResetCredits, normalizeActivity, OpenAIError };

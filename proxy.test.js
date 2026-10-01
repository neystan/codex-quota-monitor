const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowsProxy, parseMacProxy, getSystemProxy } = require('./proxy');
const settings = (server, extra = '') => `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    ${server}
    ${extra}
`;

test('系统代理支持单一地址、端口变化和 HTTP / HTTPS 分别配置', () => {
  assert.equal(parseWindowsProxy(settings('127.0.0.1:7897')).httpsProxy, 'http://127.0.0.1:7897');
  assert.equal(parseWindowsProxy(settings('127.0.0.1:15732')).httpsProxy, 'http://127.0.0.1:15732');
  const split = parseWindowsProxy(settings('http=127.0.0.1:8001;https=127.0.0.1:8002'));
  assert.equal(split.httpProxy, 'http://127.0.0.1:8001');
  assert.equal(split.httpsProxy, 'http://127.0.0.1:8002');
});
test('系统代理关闭时直连，不使用残留地址', () => {
  assert.equal(parseWindowsProxy('ProxyEnable    REG_DWORD    0x0\nProxyServer    REG_SZ    127.0.0.1:7897').mode, 'direct');
});
test('PAC、SOCKS 和包含凭证的地址明确报告不支持', () => {
  assert.throws(() => parseWindowsProxy('ProxyEnable    REG_DWORD    0x0\nAutoConfigURL    REG_SZ    http://localhost/proxy.pac'), /PAC/);
  for (const address of ['socks=127.0.0.1:1080', 'http://user:password@127.0.0.1:7897', 'http://127.0.0.1:7897/path'])
    assert.throws(() => parseWindowsProxy(settings(address)));
});

const macSettings = fields => `<dictionary> {\n${Object.entries(fields).map(([key, value]) => '  ' + key + ' : ' + value).join('\n')}\n}`;
test('macOS 分别读取 HTTP / HTTPS 代理，变化或关闭后不沿用旧端口', () => {
  const first = parseMacProxy(macSettings({ HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 7897, HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 8002 }));
  assert.equal(first.httpProxy, 'http://127.0.0.1:7897');
  assert.equal(first.httpsProxy, 'http://127.0.0.1:8002');
  assert.equal(parseMacProxy(macSettings({ HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 15732 })).httpsProxy, 'http://127.0.0.1:15732');
  assert.equal(parseMacProxy(macSettings({ HTTPEnable: 0, HTTPProxy: '127.0.0.1', HTTPPort: 7897 })).mode, 'direct');
});
test('macOS 不把嵌套接口配置当作当前生效的代理', () => {
  const output = '<dictionary> {\n  __SCOPED__ : <dictionary> {\n    en0 : <dictionary> {\n      HTTPEnable : 1\n      HTTPProxy : wrong.example\n      HTTPPort : 9000\n    }\n  }\n  HTTPEnable : 1\n  HTTPProxy : localhost\n  HTTPPort : 7897\n}';
  assert.equal(parseMacProxy(output).proxyUrl, 'http://localhost:7897');
  assert.equal(parseMacProxy(output.replace('  HTTPEnable : 1\n  HTTPProxy : localhost\n  HTTPPort : 7897\n', '')).mode, 'direct');
});
test('macOS 的 PAC、仅 SOCKS、无效端口和凭证地址明确报错', () => {
  assert.throws(() => parseMacProxy(macSettings({ ProxyAutoConfigEnable: 1 })), /PAC/);
  assert.throws(() => parseMacProxy(macSettings({ ProxyAutoDiscoveryEnable: 1 })), /PAC/);
  assert.throws(() => parseMacProxy(macSettings({ SOCKSEnable: 1 })), /SOCKS/);
  for (const port of [0, 65536, 'not-a-port'])
    assert.throws(() => parseMacProxy(macSettings({ HTTPEnable: 1, HTTPProxy: 'localhost', HTTPPort: port })), /地址无效/);
  assert.throws(() => parseMacProxy(macSettings({ HTTPEnable: 1, HTTPProxy: 'user:secret@localhost', HTTPPort: 7897 })));
  assert.throws(() => parseMacProxy('unrecognized output'), /格式无效/);
  assert.equal(parseMacProxy(macSettings({ HTTPEnable: 1, HTTPProxy: '::1', HTTPPort: 7897 })).proxyUrl, 'http://[::1]:7897');
});
test('macOS 调用 scutil 只读命令，失败时不退回直连或显示命令原文', () => {
  const result = getSystemProxy({ platform: 'darwin', run: (file, args) => {
    assert.equal(file, '/usr/sbin/scutil'); assert.deepEqual(args, ['--proxy']);
    return macSettings({ HTTPEnable: 1, HTTPProxy: 'localhost', HTTPPort: 7897 });
  } });
  assert.equal(result.mode, 'system');
  const failed = getSystemProxy({ platform: 'darwin', run: () => { throw new Error('private command details'); } });
  assert.equal(failed.mode, 'unavailable'); assert.match(failed.error, /macOS/); assert.doesNotMatch(failed.error, /private/);
});
test('Linux 环境变量代理标为环境代理', () => {
  assert.equal(getSystemProxy({ platform: 'linux', env: { HTTPS_PROXY: 'http://localhost:7897' } }).mode, 'environment');
});

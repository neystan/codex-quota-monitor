const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { dataDirectory, assertNodeVersion, configuredPort } = require('./runtime');

test('跨平台数据目录：macOS 忽略 Windows 环境变量，测试不会触碰真实授权', () => {
  const env = { LOCALAPPDATA: '/fake/windows', HOME: '/fake/mac' };
  assert.equal(dataDirectory('win32', env), path.join(env.LOCALAPPDATA, 'CodexQuotaMonitor'));
  assert.equal(dataDirectory('darwin', env), path.join(env.HOME, 'CodexQuotaMonitor'));
});
test('运行版本拒绝没有原生代理 API 的旧 Node.js', () => {
  for (const version of ['20.19.0', '22.20.0', '24.13.0']) assert.throws(() => assertNodeVersion(version), /24\.14/);
  for (const version of ['24.14.0', '24.19.0', '26.0.0']) assert.doesNotThrow(() => assertNodeVersion(version));
});
test('启动入口和服务一致校验端口', () => {
  assert.equal(configuredPort({ port: 17880 }), 17880);
  for (const port of [undefined, 80, 65536, '17880', 17880.1]) assert.throws(() => configuredPort({ port }));
});

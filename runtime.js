const path = require('node:path');
const os = require('node:os');

function dataDirectory(platform = process.platform, env = process.env) {
  return path.join(platform === 'win32' ? env.LOCALAPPDATA || os.homedir() : env.HOME || os.homedir(), 'CodexQuotaMonitor');
}

function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 14))
    throw new Error('需要 Node.js 24.14 或更新版本，请先更新 Node.js。');
}

function configuredPort(config) {
  const port = config.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机端口配置无效');
  return port;
}

module.exports = { dataDirectory, assertNodeVersion, configuredPort };

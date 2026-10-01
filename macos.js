const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { dataDirectory, assertNodeVersion, configuredPort } = require('./runtime');

const LABEL = 'local.codex-quota-monitor';
const MARKER = '<!-- CodexQuotaMonitor LaunchAgent -->';
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));

function launchAgentPlist({ label = LABEL, nodePath, serverPath, projectDir, dataDir, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
${MARKER}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(serverPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(projectDir)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(path.posix.join(dataDir, 'startup.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.posix.join(dataDir, 'startup-error.log'))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>
`;
}

function monitorReady(port) {
  return new Promise(resolve => {
    const agent = new http.Agent({ proxyEnv: { http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' } });
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/status', agent }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 1048576) request.destroy(); });
      response.on('end', () => {
        agent.destroy();
        try { resolve(response.statusCode === 200 && Array.isArray(JSON.parse(body).accounts)); } catch { resolve(false); }
      });
      response.on('error', () => { agent.destroy(); resolve(false); });
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => { agent.destroy(); resolve(false); });
  });
}

function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function runAction(action = 'Start', {
  platform = process.platform, home = os.homedir(), projectDir = __dirname,
  nodePath = process.execPath, uid = process.getuid?.(), label = LABEL,
  command = execFileSync, ready = monitorReady, occupied = portOccupied,
  startupTimeout = 15000
} = {}) {
  if (platform !== 'darwin') throw new Error('此入口仅用于 macOS；Windows 请使用 windows.ps1。');
  if (!Number.isInteger(uid) || uid === 0) throw new Error('请使用已登录的普通用户运行，无需 sudo。');
  if (!['Start', 'Stop', 'Install', 'Uninstall', 'Status', 'Open'].includes(action)) throw new Error('操作应为 Start、Stop、Install、Uninstall、Status 或 Open。');
  assertNodeVersion();
  const dataDir = dataDirectory('darwin', { HOME: home });
  const serverPath = path.join(projectDir, 'server.js');
  const transientFile = path.join(dataDir, 'launch-agent.plist');
  const installedFile = path.join(home, 'Library', 'LaunchAgents', label + '.plist');
  const domain = `gui/${uid}`, target = `${domain}/${label}`;
  const launchctl = args => command('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
  const text = await fs.readFile(path.join(dataDir, 'config.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"port":17880}'; throw error; });
  const port = configuredPort(JSON.parse(text)), url = `http://127.0.0.1:${port}/`;
  const definition = launchAgentPlist({ label, nodePath, serverPath, projectDir, dataDir, home });
  async function ownedFile(file) {
    const content = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (content !== null && (!content.includes(MARKER) || !content.includes(`<string>${xml(serverPath)}</string>`)))
      throw new Error('存在同名的其他启动项或旧项目路径；请先在原目录移除自动启动。');
    return content !== null;
  }
  await ownedFile(transientFile);
  const installed = await ownedFile(installedFile);
  let loaded = '';
  try { loaded = launchctl(['print', target]); } catch (error) {
    if (error.status !== 113) throw new Error('无法读取当前用户的 LaunchAgent；请在登录后的终端运行。');
  }
  if (loaded && !loaded.includes(serverPath)) throw new Error('同名 LaunchAgent 属于其他项目，未修改它。');
  if (action === 'Status')
    return `服务：${await ready(port) ? '运行中' : '未运行'}；自动启动：${installed ? '已安装' : '未安装'}；${url}`;
  if (action === 'Stop') {
    if (loaded) launchctl(['bootout', target]);
    return loaded ? '后台服务已停止；登录自动启动设置保留。' : '当前没有由此入口管理的服务；手动启动的服务请在原终端按 Ctrl+C。';
  }
  if (action === 'Uninstall') {
    if (installed) await fs.unlink(installedFile);
    return '登录自动启动已移除；当前服务和账号授权保留。';
  }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  if (action === 'Install') {
    await fs.mkdir(path.dirname(installedFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(installedFile, definition, { mode: 0o600 });
    await fs.chmod(installedFile, 0o600);
  }
  if (!await ready(port)) {
    if (!loaded && await occupied(port)) throw new Error(`端口 ${port} 已被占用，未启动第二个服务。`);
    await fs.writeFile(transientFile, definition, { mode: 0o600 });
    await fs.chmod(transientFile, 0o600);
    for (const name of ['startup.log', 'startup-error.log']) {
      const log = path.join(dataDir, name);
      await fs.writeFile(log, '', { mode: 0o600 });
      await fs.chmod(log, 0o600);
    }
    try {
      if (loaded) launchctl(['kickstart', target]);
      else launchctl(['bootstrap', domain, transientFile]);
    } catch { throw new Error('LaunchAgent 启动失败；请在已登录的 macOS 桌面运行，并检查项目目录权限。'); }
    const deadline = Date.now() + startupTimeout;
    while (!await ready(port)) {
      if (Date.now() >= deadline) throw new Error('服务未就绪，请查看本机 startup-error.log；Node.js 路径或端口可能不可用。');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (action === 'Open') command('/usr/bin/open', [url], { stdio: 'ignore', timeout: 5000 });
  return `${action === 'Install' ? '登录自动启动已安装；' : ''}服务已在后台运行；${url}`;
}

if (require.main === module) {
  if (process.platform === 'darwin') process.umask(0o077);
  runAction(process.argv[2] || 'Start').then(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runAction, launchAgentPlist, monitorReady };

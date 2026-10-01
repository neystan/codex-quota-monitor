const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { runAction, launchAgentPlist, monitorReady } = require('./macos');
const { getSystemProxy, parseMacProxy } = require('./proxy');

async function temporaryHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mac-test-'));
  t.after(async () => {
    const resolved = path.resolve(home);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codex-mac-test-')) throw new Error('测试清理路径不匹配');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return home;
}
async function mockMac(t, initialLoaded = false) {
  const home = await temporaryHome(t), server = path.join(__dirname, 'server.js'), calls = [];
  let loaded = initialLoaded, running = initialLoaded;
  const options = { platform: 'darwin', home, uid: 501, ready: async () => running, occupied: async () => false,
    command: (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/open') return '';
      if (args[0] === 'print') { if (!loaded) throw Object.assign(new Error('missing'), { status: 113 }); return 'program arguments = ' + server; }
      if (args[0] === 'bootstrap' || args[0] === 'kickstart') { loaded = true; running = true; }
      if (args[0] === 'bootout') { loaded = false; running = false; }
      return '';
    } };
  return { home, options, calls, setRunning: value => { running = value; } };
}

test('Mac 安装、重复启动、停止、恢复、移除：只管理当前项目，不打开网页', async t => {
  const fixture = await mockMac(t), { home, options, calls } = fixture;
  await runAction('Install', options);
  const file = path.join(home, 'Library', 'LaunchAgents', 'local.codex-quota-monitor.plist');
  const plist = await fs.readFile(file, 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  await runAction('Start', options);
  assert.equal(calls.filter(c => c.args[0] === 'bootstrap').length, 1);
  assert.equal(calls.filter(c => c.file === '/usr/bin/open').length, 0);
  await runAction('Stop', options);
  assert.equal(await fs.readFile(file, 'utf8'), plist);
  await runAction('Start', options);
  await runAction('Uninstall', options);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.match(await runAction('Status', options), /运行中.*未安装/);
  await runAction('Stop', options);
  assert.match(await runAction('Status', options), /未运行/);
});
test('Mac 显式 Open 才打开默认浏览器，已加载但停止的任务可以恢复', async t => {
  const fixture = await mockMac(t, true);
  fixture.setRunning(false);
  await runAction('Open', fixture.options);
  assert.equal(fixture.calls.filter(c => c.args[0] === 'kickstart').length, 1);
  assert.deepEqual(fixture.calls.find(c => c.file === '/usr/bin/open').args, ['http://127.0.0.1:17880/']);
});
test('Mac 遇到端口占用、其他项目的启动项或启动超时，不误停其他服务', async t => {
  const fixture = await mockMac(t);
  await assert.rejects(runAction('Start', { ...fixture.options, occupied: async () => true }), /占用/);
  assert.equal(fixture.calls.filter(c => c.args[0] === 'bootstrap').length, 0);
  await assert.rejects(runAction('Stop', { ...fixture.options, command: () => 'program arguments = /other/server.js' }), /其他项目/);
  await assert.rejects(runAction('Start', { ...fixture.options, ready: async () => false, startupTimeout: 0 }), /未就绪/);
  const installed = path.join(fixture.home, 'Library', 'LaunchAgents', 'local.codex-quota-monitor.plist');
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.writeFile(installed, 'unrelated file');
  await assert.rejects(runAction('Install', fixture.options), /同名/);
  assert.equal(await fs.readFile(installed, 'utf8'), 'unrelated file');
});
test('Mac plist 正确转义带空格、中文及 XML 特殊字符的路径', () => {
  const plist = launchAgentPlist({ nodePath: '/usr/local/bin/node', serverPath: '/Users/demo/中文 & "quota"/server.js', projectDir: '/Users/demo/中文 & "quota"', dataDir: '/Users/demo/CodexQuotaMonitor', home: '/Users/demo' });
  assert.match(plist, /中文 &amp; &quot;quota&quot;/);
  assert.match(plist, /<array><string>\/usr\/local\/bin\/node<\/string><string>/);
});
test('Mac 入口拒绝其他平台、sudo 和无效操作', async () => {
  await assert.rejects(runAction('Start', { platform: 'win32' }), /仅用于 macOS/);
  await assert.rejects(runAction('Start', { platform: 'darwin', uid: 0 }), /无需 sudo/);
  await assert.rejects(runAction('Invalid', { platform: 'darwin', uid: 501 }), /操作应为/);
});
test('本地健康检查不能把普通网站当成监控服务', async t => {
  let valid = false;
  const listener = http.createServer((request, response) => response.end(valid ? '{"accounts":[]}' : 'unrelated website'));
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  assert.equal(await monitorReady(listener.address().port), false);
  valid = true;
  assert.equal(await monitorReady(listener.address().port), true);
});

test('macOS 原生验证：scutil、plutil、shell 和 POSIX 权限', { skip: process.platform !== 'darwin' }, async t => {
  const home = await temporaryHome(t);
  const raw = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
  assert.deepEqual(getSystemProxy(), parseMacProxy(raw));
  const file = path.join(home, 'test.plist');
  await fs.writeFile(file, launchAgentPlist({ nodePath: process.execPath, serverPath: path.join(__dirname, 'server.js'), projectDir: __dirname, dataDir: home, home }), { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', file]);
  execFileSync('/bin/bash', ['-n', path.join(__dirname, 'macos.command')]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
test('macOS 原生验证：LaunchAgent 真实启停和自动启动安装生命周期', { skip: process.platform !== 'darwin', timeout: 60000 }, async t => {
  const uid = process.getuid();
  try { execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'pipe' }); }
  catch { t.skip('当前 Mac 运行环境没有 GUI 登录域；其余原生检查仍运行。'); return; }
  const home = await temporaryHome(t), label = `local.codex-quota-monitor.test.${process.pid}`;
  const data = path.join(home, 'CodexQuotaMonitor');
  await fs.mkdir(data, { mode: 0o700 });
  const temporaryListener = http.createServer();
  await new Promise(resolve => temporaryListener.listen(0, '127.0.0.1', resolve));
  const port = temporaryListener.address().port;
  await new Promise(resolve => temporaryListener.close(resolve));
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ port }), { mode: 0o600 });
  const options = { home, label };
  t.after(() => { try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'pipe' }); } catch {} });
  await runAction('Start', options);
  const pid = () => /pid = (\d+)/.exec(execFileSync('/bin/launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' }))?.[1];
  const firstPid = pid(); assert.ok(firstPid);
  await runAction('Start', options); assert.equal(pid(), firstPid);
  assert.equal((await fs.stat(data)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(data, 'accounts.json'))).mode & 0o777, 0o600);
  await runAction('Install', options);
  assert.match(await runAction('Status', options), /运行中.*已安装/);
  await runAction('Uninstall', options);
  assert.match(await runAction('Status', options), /运行中.*未安装/);
  await runAction('Stop', options);
  assert.equal(await monitorReady(port), false);
});

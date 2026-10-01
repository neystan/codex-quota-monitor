const { execFileSync } = require('node:child_process');

function proxyUrl(address) {
  if (!address) return '';
  const url = new URL(address.includes('://') ? address : `http://${address}`);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('系统代理地址暂不支持，请在代理软件中启用系统 HTTP 代理。');
  return url.origin;
}

function parseWindowsProxy(output) {
  const value = name => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(output)?.[1] || '';
  if (parseInt(value('ProxyEnable'), 16) !== 1) {
    if (value('AutoConfigURL')) throw new Error('系统使用 PAC 自动代理脚本，请在代理软件中启用系统 HTTP 代理。');
    return { mode: 'direct', httpProxy: '', httpsProxy: '', proxyUrl: '' };
  }
  const server = value('ProxyServer');
  const entries = server.includes('=') ? Object.fromEntries(server.split(';').map(part => part.trim().split('='))) : null;
  const httpProxy = proxyUrl(entries ? entries.http : server);
  const httpsProxy = proxyUrl(entries ? entries.https || entries.http : server);
  if (!httpProxy && !httpsProxy) throw new Error('未找到系统 HTTP 代理，请检查代理软件的系统代理开关。');
  return { mode: 'system', httpProxy, httpsProxy, proxyUrl: httpsProxy || httpProxy };
}

function parseMacProxy(output) {
  // scutil 还会输出嵌套的按接口设置；这里只采用当前生效的顶层配置。
  const values = {};
  let depth = 0;
  for (const line of output.split(/\r?\n/)) {
    const entry = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
    if (depth === 1 && entry) values[entry[1]] = entry[2];
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  if (!output.trim().startsWith('<dictionary> {') || depth !== 0) throw new Error('系统代理输出格式无效。');
  const address = type => {
    if (values[type + 'Enable'] !== '1') return '';
    const host = values[type + 'Proxy'], port = Number(values[type + 'Port']);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('系统代理地址无效，请检查 macOS 代理设置。');
    return proxyUrl(`${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${port}`);
  };
  const httpProxy = address('HTTP'), httpsProxy = address('HTTPS') || httpProxy;
  if (!httpProxy && !httpsProxy) {
    if (values.ProxyAutoConfigEnable === '1' || values.ProxyAutoDiscoveryEnable === '1')
      throw new Error('系统使用 PAC 自动代理，请在代理软件中启用系统 HTTP 代理。');
    if (values.SOCKSEnable === '1') throw new Error('系统仅启用了 SOCKS 代理，请启用系统 HTTP 代理。');
  }
  return { mode: httpProxy || httpsProxy ? 'system' : 'direct', httpProxy, httpsProxy, proxyUrl: httpsProxy || httpProxy };
}

function getSystemProxy({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  try {
    if (platform === 'win32') {
      return parseWindowsProxy(run('reg.exe', ['query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }));
    }
    if (platform === 'darwin') return parseMacProxy(run('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }));
    const httpProxy = proxyUrl(env.http_proxy || env.HTTP_PROXY);
    const httpsProxy = proxyUrl(env.https_proxy || env.HTTPS_PROXY || httpProxy);
    return { mode: httpProxy || httpsProxy ? 'environment' : 'direct', httpProxy, httpsProxy, proxyUrl: httpsProxy || httpProxy };
  } catch (error) {
    return { mode: 'unavailable', httpProxy: '', httpsProxy: '', proxyUrl: '',
      error: error instanceof TypeError ? '系统代理地址无效，请检查代理软件的系统代理设置。' :
        (error.message.startsWith('系统') || error.message.startsWith('未找到') ? error.message :
          `无法读取系统代理，请检查 ${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '环境变量'} 代理设置。`) };
  }
}

module.exports = { getSystemProxy, parseWindowsProxy, parseMacProxy };

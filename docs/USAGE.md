# 完整使用说明

[返回项目首页](../README.md) · [项目仓库](https://github.com/neystan/codex-quota-monitor)

极简的本地 Codex 多账号额度监控工具。Node.js + 原生 HTML/CSS/JS，**零 npm 运行依赖**。

通过普通浏览器完成 ChatGPT OAuth，查看套餐、剩余额度、重置倒计时和账号状态。后台每 5 分钟刷新，单个账号失败不影响其他账号。支持拖动排序；宽屏三列，中等宽度两列，手机单列，末行居中。

## 运行依赖

| 内容 | 要求 |
| --- | --- |
| Node.js | 24.14 或更新版本；目前发布的是源码，需要自行安装 |
| 浏览器 | 普通现代浏览器，允许打开 OAuth 登录窗口；无需指定 Edge 或 Chrome |
| Windows | 系统自带 PowerShell、计划任务和注册表工具 |
| macOS | 13.5+，Intel / Apple Silicon；使用自带 bash、scutil、launchctl、open |
| 网络 | 可访问 OpenAI 登录和 Codex 额度接口；需要代理时启用系统 HTTP 代理 |

**无需 npm install**。没有前端框架、数据库、Electron、Codex CLI、浏览器自动化、外部字体或图片服务。Git 仅用于下载和开发源码，不是运行依赖。

## Windows

解压到固定目录，在该目录执行：

```powershell
# 在后台启动，不打开网页
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Start
# 安装登录后自启动，同时创建桌面 HTML 入口并启动服务
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Install
# 查看状态 / 停止 / 移除自启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Uninstall
```

打开 [本机监控页](http://127.0.0.1:17880/)。自启动使用当前用户的计划任务，登录后后台运行，网页按需打开；启动用的 PowerShell 随后退出。重复启动不会再开一个服务。

## macOS

安装符合版本要求的 Node.js，解压到固定、当前用户可访问的目录。在终端进入项目目录：

```sh
chmod +x macos.command
# 启动后台服务，并用默认浏览器打开页面
./macos.command
# 只启动后台服务
./macos.command Start
# 安装登录后自启动，不自动打开网页
./macos.command Install
# 查看状态 / 停止 / 移除自启动
./macos.command Status
./macos.command Stop
./macos.command Uninstall
```

第一次设置执行权限后，也可在 Finder 双击 macos.command。不需要 sudo、Homebrew、Python 或 Xcode。启动脚本优先使用 runtime/node（如自行提供），随后查找 PATH 和常见 Node.js 安装位置。

使用当前用户的 LaunchAgent，自启动只运行 Node 服务，没有额外常驻管理进程。Stop 停止由脚本管理的服务，自启动设置保留；Uninstall 仅移除下次登录自动启动，当前服务及授权保留。系统设置如询问是否允许后台项目，需要由用户选择允许。

移动项目目录或更换 Node.js 安装位置前，在原目录执行 Stop 和 Uninstall；到新目录重新执行 Install。

## 通用使用

- 添加账号：在浏览器完成 OAuth；可以继续添加其他账号。授权页可能默认当前浏览器账号，请选择目标账号；重复登录更新已有条目。
- 重新登录：更新指定账号授权，不会用另一个身份覆盖原账号。
- 移除：删除本机保存的该账号授权，停止查询。
- 排序：拖动卡片顶部或点阵手柄，也可用手柄上的方向键移动。刷新和重启后保留顺序。
- 刷新全部：立即更新额度、奖励次数，以及已查看过的奖励明细和活动统计；跳过成功缓存，仍遵守服务端限流等待时间。
- 重置奖励：卡片显示可用次数，跟随五分钟额度刷新；「详情」中查看每份奖励的状态和有效期，仅展示，不兑换。
- 使用活动：展开「详情」查看累计／单日最高 Token、连续使用天数、最长任务、会话数和最近每日用量；悬停指标可看完整数值，柱条以「万／亿」简洁显示每日用量。
- 连接状态：查看自动读取到的系统代理或直连状态。

服务只监听 127.0.0.1。关闭网页不影响后台刷新。前端每分钟读取本地缓存，登录或刷新时暂时每 5 秒读取；倒计时每秒在本地更新，网页隐藏后停止前端定时器。

奖励明细和活动首次展开时查询，成功结果在内存缓存 15 分钟。后台额度刷新发现奖励次数变化，会清除旧奖励明细并重新查询；已查看的奖励明细也会在缓存到期后的后台刷新中更新，展开的页面随本地状态同步。活动在再次展开或点击「刷新全部」时更新。无需本地历史采样或数据库。活动来自 Codex 服务端汇总，以显示的统计日期为准，Token 数不能直接换算为套餐额度百分比。缺失数据显示「—」，单项查询失败不会影响额度或另一项统计；奖励次数已变化但查询失败时，不继续显示旧奖励为可用。

也可在终端运行 node server.js（或 npm start），用 Ctrl+C 停止；手动运行的服务不由 macOS 启动脚本停止。

## 系统代理

Windows 读取当前用户的系统 HTTP 代理；macOS 通过 scutil --proxy 读取当前有效的系统 HTTP / HTTPS 代理。只读取设置，不修改系统配置。启动、每轮刷新和登录前重新读取；可点击“刷新全部”应用已变更的端口。

代理软件保持规则模式并启用“系统代理”即可，由代理软件决定分流；无需虚拟网卡。系统 HTTP 代理关闭时直连。本地网页及登录回调绕过代理。PAC 自动脚本、仅 SOCKS 及带用户名密码的代理地址暂不支持，会明确提示。

其他平台仅提供核心服务，通过 HTTP_PROXY / HTTPS_PROXY 等环境变量读取代理，不提供桌面自启动适配。

## 本机文件和授权

| 平台 | 数据目录 |
| --- | --- |
| Windows | %LOCALAPPDATA%\CodexQuotaMonitor\ |
| macOS | ~/CodexQuotaMonitor/ |

config.json 保存本地端口（默认 17880），修改后重启服务。accounts.json 保存 OAuth 凭证，**不要上传、分享或提交此文件**；不保存密码或额度历史。Windows 目录访问限制为当前用户和 SYSTEM；macOS 目录权限为 0700，认证文件为 0600。凭证未加密，依赖当前系统用户的文件权限保护。

前端和日志不输出 Token。启动日志 startup.log / startup-error.log 在上述目录内，每次由启动脚本启动时覆盖。macOS 的启动描述文件也在数据目录，登录自动启动文件位于 ~/Library/LaunchAgents/local.codex-quota-monitor.plist。

OAuth 回调临时使用 http://localhost:1455/auth/callback，监听只绑定 127.0.0.1；完成、取消或 10 分钟超时即关闭，1455 端口需空闲。

## 额度与兼容性

README 截图使用虚拟 Plus / Pro 账号和模拟额度；Pro 示例展示接口只返回周额度时的布局，实际窗口以接口响应为准。

首页内存数字来自 Windows 上三个 Plus 账号的后台进程工作集测量，本次空闲采样约 53.6 MB，页面展示取约 55 MB；不含浏览器，不代表刷新峰值或其他设备的固定占用。

以账号接口实际响应为准，不根据套餐名虚构额度。只返回周窗口时只显示一周；字段缺失显示未知，不能据此推断无限额度。Pro 显示已通过模拟数据验证，真实 Pro 账号查询仍待验证。套餐续费日期和切换指定浏览器账号的 ChatGPT 入口尚未提供。

这是非官方工具。OAuth 和 usage 使用 Codex 客户端兼容参数及非公开接口，未来可能变化或停止工作。适配集中在 openai.js；代理读取集中在 proxy.js。授权失效显示“需要重新登录”，其他查询错误分别处理；401 按允许的续期时间重试一次，429 遵守 Retry-After。

## 检查与验证范围

```sh
npm run check
npm test
```

测试使用临时目录、假账号和独立端口，不读取用户真实授权。Windows 本地完整测试为 43 项通过、2 项原生 macOS 检查跳过；模拟 macOS 服务分支的 10 项集成检查通过。macOS 启动控制通过模拟 launchctl 验证，不能代替 Finder、系统代理和登录后自启动的真机验证。

.github/workflows/test.yml 配置 Windows、macOS Apple Silicon 和 Intel 检查，包含真实 scutil、plutil、POSIX 文件权限和 LaunchAgent 启停测试。没有 GUI 登录域时仅跳过 LaunchAgent 原生生命周期测试。已在真正的 GitHub Mac 运行环境验证：Apple Silicon 与 Intel 均为 39 项通过、0 项跳过；Windows 检查也通过。[查看原生跨平台检查结果](https://github.com/neystan/codex-quota-monitor/actions/runs/36821805810)。CI 不进行真实账号登录，也不能代替 Finder 双击及用户真正退出系统后再登录的操作验证。

当前提供源码运行方式，尚未提供内置 Node.js 的下载即运行安装包。

## 许可证

[MIT](../LICENSE)。

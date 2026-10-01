# Codex Quota Monitor

一个轻量的本地 **Codex 多账号额度监控工具**：查看剩余额度和重置时间，支持 Windows / macOS。

![Plus 与 Pro 虚拟账号预览](docs/assets/preview.jpg)

> 截图中的 Plus / Pro 账号与额度均为模拟数据。Pro 示例展示仅返回周额度的布局，实际窗口以接口响应为准。

## 为什么用它

- **轻量常驻**：仅一个 Node.js 后台进程。本机 Windows、3 个 Plus 账号实测约 **59 MB 内存**，适合长期后台运行；不含浏览器，数值会随环境和刷新变化。
- **零 npm 依赖**：Node.js + 原生网页，无需 `npm install`，没有数据库、Electron 或浏览器自动化。
- **多账号，一眼查看**：剩余额度、重置倒计时、拖动排序，每 5 分钟自动刷新；单个账号失败不影响其他账号。
- **只在本机运行**：浏览器 OAuth 登录，不保存密码；授权只存本机，网页不接触 Token，服务仅监听 localhost。

## 快速开始

1. 安装 **[Node.js 24.14 或更新版本](https://nodejs.org/en/download)**。
2. **[下载源码 ZIP](https://github.com/neystan/codex-quota-monitor/archive/refs/heads/main.zip)**，解压到固定目录，在该目录打开终端。
3. 按下面的方法启动，打开 **[监控页面](http://127.0.0.1:17880/)**，点击「添加账号」完成登录。

当前下载的是源码，需要先安装 Node.js。如果需要代理，打开代理软件的「系统代理」即可自动读取，无需手填端口或开启虚拟网卡；[代理详情](docs/USAGE.md#系统代理)。

### Windows

**登录后自动启动**（推荐，只需执行一次；立即启动服务，并创建桌面网页入口）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Install
```

**手动后台启动**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Start
```

<details>
<summary>停止服务、取消自启动、查看状态</summary>

```powershell
# 停止当前服务
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Stop
# 取消登录后自启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Uninstall
# 查看运行状态
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows.ps1 -Action Status
```

</details>

### macOS

在项目目录执行，第一次需要设置执行权限：

```sh
chmod +x macos.command
./macos.command Install   # 登录后自动启动，立即启动后台服务
```

**手动启动并打开网页**：双击 `macos.command`，或执行 `./macos.command`。

<details>
<summary>仅后台启动、停止服务、取消自启动、查看状态</summary>

```sh
./macos.command Start       # 仅后台启动
./macos.command Stop        # 停止当前服务
./macos.command Uninstall   # 取消登录后自启动
./macos.command Status      # 查看运行状态
```

</details>

两种系统的自启动均只在后台运行，**不会自动弹出网页**。`Stop` 保留自启动设置，下次登录仍会启动；`Uninstall` 保留当前运行的服务。需要彻底停用时，两者都执行，账号授权会保留。

也可直接运行 `node server.js`，在原终端按 **Ctrl+C** 停止；这种方式需要保持终端打开。**关闭网页只关闭界面，不会停止后台服务。**

## 更多说明

详细的账号操作、系统代理、数据保存位置、日志、兼容性和测试说明，都保留在 **[完整使用说明](docs/USAGE.md)**。

非官方工具，使用的非公开接口可能变化。真实 Pro 账号查询仍待验证。不要分享本机的 `accounts.json` 授权文件。

[MIT License](LICENSE)

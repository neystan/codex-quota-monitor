#!/bin/bash
set -e
umask 077
cd -- "$(dirname -- "$0")"
if [ "$(uname -s)" != Darwin ]; then
  echo "此入口仅用于 macOS；Windows 请使用 windows.ps1。" >&2
  exit 1
fi
if [ -x ./runtime/node ]; then
  monitor_node=./runtime/node
elif command -v node >/dev/null 2>&1; then
  monitor_node=$(command -v node)
elif [ -x /opt/homebrew/bin/node ]; then
  monitor_node=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  monitor_node=/usr/local/bin/node
else
  echo "请先安装 Node.js 24.14 或更新版本，然后重新运行此文件。" >&2
  exit 1
fi
"$monitor_node" "$PWD/macos.js" "${1:-Open}"

#!/usr/bin/env bash
set -euo pipefail

ok() { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
bad() { printf "\033[1;31m[bad]\033[0m %s\n" "$*"; }

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd: $(command -v "$cmd")"
  else
    bad "缺少命令：$cmd"
  fi
}

echo "== 基础环境 =="
echo "OS: $(sw_vers -productName 2>/dev/null || uname -s) $(sw_vers -productVersion 2>/dev/null || true)"
check_cmd node
check_cmd npm
check_cmd wx
check_cmd opencli

if command -v node >/dev/null 2>&1; then
  echo "Node: $(node -v)"
fi

echo
echo "== 微信 App =="
if [[ -d "/Applications/WeChat.app" ]]; then
  ok "找到 /Applications/WeChat.app"
  codesign -dv "/Applications/WeChat.app" 2>&1 | sed 's/^/  /' || warn "无法读取 WeChat 签名信息。"
else
  bad "没有找到 /Applications/WeChat.app"
fi

echo
echo "== wx-cli 状态 =="
if [[ -d "$HOME/.wx-cli" ]]; then
  ok "找到 $HOME/.wx-cli"
else
  warn "没有找到 $HOME/.wx-cli，可能还没有运行 sudo wx init。"
fi

if command -v wx >/dev/null 2>&1; then
  echo
  echo "尝试读取最近 5 个会话："
  wx sessions -n 5 || warn "wx sessions 失败。常见原因：微信没登录、终端没有完全磁盘访问权限、没有成功 wx init、微信升级后需要重新重签名。"
fi

if command -v opencli >/dev/null 2>&1; then
  echo
  echo "尝试通过 opencli 读取最近 5 个会话："
  opencli wx sessions -n 5 || warn "opencli wx sessions 失败。先确认 wx sessions 是否正常。"
fi

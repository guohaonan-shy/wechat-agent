#!/usr/bin/env bash
set -euo pipefail

info() { printf "\033[1;34m[info]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }

confirm() {
  local prompt="${1:-继续？}"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "这个安装脚本目前只支持 macOS。"
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local major
    major="$(node -p "Number(process.versions.node.split('.')[0])")"
    if [[ "$major" -ge 21 ]]; then
      info "Node.js 版本满足要求：$(node -v)"
      return 0
    fi
    warn "当前 Node.js 是 $(node -v)，OpenCLI 建议 Node.js >= 21。"
  else
    warn "没有找到 Node.js / npm。"
  fi

  if command -v brew >/dev/null 2>&1; then
    if confirm "是否用 Homebrew 安装或升级 Node.js？"; then
      brew install node || brew upgrade node
      return 0
    fi
  fi

  fail "请先安装 Node.js >= 21，然后重新运行本脚本：https://nodejs.org/"
}

install_npm_tools() {
  info "安装 opencli 和 wx-cli。"
  if npm install -g @jackwener/opencli @jackwener/wx-cli; then
    info "npm 全局安装完成。"
    return 0
  fi

  warn "普通 npm 全局安装失败，通常是全局目录权限问题。"
  if confirm "是否改用 sudo npm install -g 安装？"; then
    sudo npm install -g @jackwener/opencli @jackwener/wx-cli
  else
    fail "未安装 opencli / wx-cli。"
  fi
}

install_agent_skills() {
  if ! command -v npx >/dev/null 2>&1; then
    warn "未找到 npx，跳过 agent skills 安装。"
    return 0
  fi

  if confirm "是否安装 opencli / wx-cli 的 agent skills？Codex、Claude Code、Qwen Code 等工具可能会用到。"; then
    npx -y skills add jackwener/opencli || warn "opencli skill 安装失败，可稍后手动安装。"
    npx -y skills add jackwener/wx-cli || warn "wx-cli skill 安装失败，可稍后手动安装。"
  fi
}

open_privacy_settings() {
  cat <<'TEXT'

接下来需要你手动开启 macOS 权限：

1. 打开 系统设置 > 隐私与安全性 > 完全磁盘访问权限。
2. 给你正在使用的终端打开权限，例如 Terminal、iTerm、Warp。
3. 如果你准备用 Codex / Claude Code / Qoder / CodeBuddy 桌面端直接读取，也给对应 App 打开权限。
4. 修改后最好重启终端或重新打开 agent。

TEXT

  if confirm "是否现在打开“完全磁盘访问权限”设置页面？"; then
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
  fi
}

prepare_wechat() {
  local app="${WECHAT_APP:-/Applications/WeChat.app}"
  if [[ ! -d "$app" ]]; then
    warn "没有找到 $app。请先安装 Mac 微信，或设置 WECHAT_APP=/path/to/WeChat.app 后重跑。"
    return 0
  fi

  cat <<TEXT

微信本地读取通常需要两件事：

1. Mac 微信已登录，并且手机聊天记录已经同步到 Mac。
2. 对 WeChat.app 做 ad-hoc 重签名，让 wx-cli 可以从本机进程里初始化读取所需信息。

这个操作只作用于本机 /Applications/WeChat.app。微信升级后可能需要重新做一次。

TEXT

  if confirm "是否现在对 $app 执行 ad-hoc 重签名？"; then
    if pgrep -x WeChat >/dev/null 2>&1; then
      info "关闭正在运行的 WeChat。"
      killall WeChat || true
      sleep 2
    fi

    sudo codesign --force --deep --sign - "$app"
    info "重新打开 WeChat。请确认微信已登录。"
    open "$app" || true
  fi
}

run_wx_init() {
  cat <<'TEXT'

`sudo wx init` 会初始化 wx-cli，并在本机用户目录下创建 ~/.wx-cli。
如果你刚刚打开微信，请等微信完全登录后再继续。

TEXT

  if confirm "是否现在运行 sudo wx init？"; then
    sudo wx init
    if [[ -d "$HOME/.wx-cli" ]]; then
      sudo chown -R "$(id -un):$(id -gn)" "$HOME/.wx-cli" || true
    fi
  fi
}

verify_basic() {
  info "检查命令。"
  command -v wx >/dev/null 2>&1 || fail "找不到 wx 命令。"
  command -v opencli >/dev/null 2>&1 || fail "找不到 opencli 命令。"

  info "wx: $(command -v wx)"
  info "opencli: $(command -v opencli)"

  if confirm "是否尝试列出微信会话来验证读取能力？"; then
    wx sessions -n 5 || warn "wx sessions 验证失败。请检查微信是否登录、完全磁盘访问权限、以及 wx init 是否成功。"
    opencli wx sessions -n 5 || warn "opencli wx sessions 验证失败。可以先直接用 wx 命令排查。"
  fi
}

main() {
  require_macos
  ensure_node
  install_npm_tools
  install_agent_skills
  open_privacy_settings
  prepare_wechat
  run_wx_init
  verify_basic

  cat <<'TEXT'

安装流程结束。

下一步：
  ./verify.sh
  ./bin/wechat-agent sessions
  ./bin/wechat-agent prompt

TEXT
}

main "$@"

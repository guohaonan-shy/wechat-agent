# WeChat Agent Kit

把今天这套“本地读取微信聊天记录，再交给 Codex / Claude Code / Qwen Code / CodeBuddy 等 agent 分析”的流程整理成一个给非技术朋友使用的 macOS 工具包。

## 这套东西是什么

它不是破解云端微信，也不是远程读取别人的微信。它做的是：

1. 让朋友把手机微信的一部分聊天记录同步到自己的 Mac 微信。
2. 用 `wx-cli` 在本机读取本地微信数据库。
3. 用 `opencli` 把 `wx-cli` 暴露成更适合 agent 调用的命令。
4. 让桌面端或命令行 agent 调用 `opencli wx ...` 做检索、导出、总结和分析。

默认设计原则：聊天数据留在本机，先导出到本地 JSON，再让 agent 基于本地文件分析。不要把原始聊天记录直接上传到不可信服务。

## 一键安装

双击：

```bash
Install.command
```

或者在终端里运行：

```bash
./install.sh
```

安装脚本会检查 Node.js、安装 `opencli` 和 `wx-cli`，并引导你给终端/agent 桌面端开启“完全磁盘访问权限”。涉及微信重签名和 `sudo wx init` 的步骤都会先询问确认。

## 安装后验证

```bash
./verify.sh
```

或者：

```bash
./bin/wechat-agent diagnose
./bin/wechat-agent sessions
```

## 常用命令

列出会话：

```bash
./bin/wechat-agent sessions
```

导出某个群最近半年的消息：

```bash
./bin/wechat-agent history "群名" --since 2025-11-11 -n 5000 --json > /tmp/group-history.json
```

搜索关键词：

```bash
./bin/wechat-agent search "关键词" -n 50
```

直接给 agent 看提示词模板：

```bash
./bin/wechat-agent prompt
```

## 给 Codex / Claude Code / 国内 agent 的接入方式

最简单方式：让 agent 直接运行 shell 命令。

```bash
opencli wx sessions
opencli wx history "群名" --since 2025-11-11 -n 5000 --json > /tmp/group-history.json
```

对能接 MCP 的工具，后续可以做一个 MCP server，把这些能力包装成：

- `wechat.sessions`
- `wechat.history`
- `wechat.search`
- `wechat.members`
- `wechat.export`

当前包先提供命令行脚本，桌面端/MCP 的产品方案在 `docs/desktop-app-plan.md`。
菜单栏桌面端的 MVP demo 方案在 `docs/desktop-mvp-demo.md`。

## 手机聊天记录同步到 Mac

朋友需要先在自己的手机和 Mac 上完成微信聊天记录同步。常见路径大致是：

1. Mac 安装并登录微信。
2. 手机微信进入“我 / 设置 / 通用 / 聊天记录迁移与备份”附近的入口。
3. 选择迁移或备份到电脑，按微信客户端提示操作。
4. 确认 Mac 微信里能搜到目标群/聊天记录。
5. 再运行本工具。

微信客户端入口会随版本变化，以上以实际客户端文案为准。

## 隐私边界

只分析自己设备里、自己有权访问的聊天记录。群聊内容涉及其他人的隐私，给朋友使用时建议默认做三件事：

- 不上传原始聊天记录。
- 导出文件放在 `/tmp` 或本地私有目录，用完删除。
- 对外分享分析结果前，去除真实姓名、手机号、住址、公司、账号等可识别信息。

## 目录结构

```text
wechat-agent-kit/
  Install.command
  install.sh
  verify.sh
  bin/wechat-agent
  docs/agent-prompts.md
  docs/domestic-agents.md
  docs/desktop-app-plan.md
  docs/desktop-mvp-demo.md
  docs/privacy-and-consent.md
```

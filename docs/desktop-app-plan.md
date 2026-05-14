# 桌面端 / MCP 产品方案

## 目标用户

不懂终端、不想折腾权限、但愿意在自己电脑上分析自己微信聊天记录的朋友。

## MVP：安装脚本

当前包就是 MVP：

- 检查 Node.js。
- 安装 `@jackwener/opencli` 和 `@jackwener/wx-cli`。
- 引导开启完全磁盘访问权限。
- 引导 WeChat ad-hoc 重签名。
- 运行 `sudo wx init`。
- 验证 `wx sessions` 和 `opencli wx sessions`。
- 提供 agent 提示词模板。

这个阶段不做数据上传，不做账号系统。

## 桌面端 v1

技术选型建议：Tauri 优先，Electron 次选。

原因：

- Tauri 打包体积小，适合 macOS 工具型 App。
- 桌面端可以提供按钮式流程，但底层仍调用本机 `opencli wx`。
- 可以用系统权限说明页引导用户打开完全磁盘访问权限。

核心页面：

1. 欢迎页：说明隐私边界，只分析自己的本机数据。
2. 环境检查页：Node、WeChat、opencli、wx-cli、完全磁盘访问权限。
3. 微信准备页：提示同步手机聊天记录，确认 Mac 微信已登录。
4. 初始化页：执行重签名、打开微信、运行 `wx init`。
5. 会话选择页：列出群聊/联系人，支持搜索。
6. 导出页：选择时间范围、消息条数、关键词。
7. Agent 接入页：
   - 复制 Codex / Claude Code / Qwen Code 提示词。
   - 生成本地 JSON 路径。
   - 可选：直接启动 CLI agent。
8. 清理页：删除临时 JSON、缓存说明。

重要限制：

- macOS 完全磁盘访问权限不能被 App 静默开启，只能引导用户手动授权。
- 微信重签名和 `wx init` 需要明确确认，不能偷偷执行。
- 微信更新后可能需要重新重签名。

## MCP v1

做一个本地 MCP server，暴露这些工具：

- `wechat_sessions`
- `wechat_history`
- `wechat_search`
- `wechat_members`
- `wechat_export`

MCP server 的职责：

- 参数校验：限制默认导出条数，避免误导出全量历史。
- 路径控制：只写入 `/tmp/wechat-agent-kit/` 或用户选择目录。
- 隐私提示：每次大规模导出前要求确认。
- 输出摘要：返回文件路径、消息数、时间范围，而不是把全部聊天记录塞回 agent 上下文。

推荐接口形态：

```json
{
  "tool": "wechat_history",
  "arguments": {
    "session": "群名",
    "since": "2025-05-11",
    "limit": 5000,
    "format": "json"
  }
}
```

返回：

```json
{
  "ok": true,
  "file": "/tmp/wechat-agent-kit/exports/group-20260511.json",
  "messageCount": 4872,
  "since": "2025-05-11"
}
```

## 推荐产品路径

1. 先把当前安装脚本给 3 到 5 个朋友试用，记录卡点。
2. 观察卡点是不是集中在权限、微信同步、`wx init`、agent 提示词。
3. 如果 80% 卡点在安装和权限，再做 Tauri 桌面端。
4. 如果 80% 卡点在 agent 不会调用命令，先做 MCP。
5. 如果大家只想要结果，不想接任何 agent，就做一个完整本地分析 App。

## 不能省略的产品提示

这个产品必须在 UI 里明确写出：

- 只处理用户本人设备上的本地微信数据。
- 不建议分析未授权对象的私人聊天。
- 结果是文本行为推理，不是心理诊断。
- 群聊分析会误伤上下文，重要判断需要人工复核。

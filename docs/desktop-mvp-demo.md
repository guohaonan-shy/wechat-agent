# Mac 桌面端 MVP Demo

## 一句话定位

一个常驻 Mac 菜单栏的微信快速问答工具：用户可以随时把自己的本机微信聊天记录接入模型，像 ChatGPT 一样发起新对话、继续已有对话，并看到回答依据。

这个 demo 不做完整微信客户端，也不替代微信。它只解决一个问题：让用户把本机微信聊天记录变成一个可查询、可追溯的模型上下文。

## 核心原则

- 微信数据默认留在本机。
- 底层读取能力依赖 `wx-cli` 和 `opencli`，桌面端不重新实现微信数据库读取。
- 桌面端负责把安装、授权、初始化、密钥处理和命令调用封装起来，用户只需要跟着 onboarding 点击确认。
- 所有高风险操作都需要明确用户授权，包括完全磁盘访问权限、微信初始化、大规模导出和发送片段给模型。
- 回答必须可追溯：用户能看到引用片段、会话名、时间范围和本地导出批次。

## Demo 范围

### 做

1. 菜单栏常驻
   - App 常驻 Mac 顶部菜单栏。
   - 支持全局快捷键唤起，例如 `Command + Shift + Space`。
   - 默认打开一个轻量浮窗，而不是完整大窗口。

2. Quick Ask 控制台
   - 打开后直接聚焦问题输入框。
   - 主页主体就是一个类似 ChatGPT 的 chatbox，用来向微信历史提问。
   - 左侧 sidebar 分成两个区域：
     - 顶部入口：新对话、搜索、设置。
     - 历史对话：展示已有 agent 对话，例如群聊摘要、联系人问答、导出批次解释。
   - 支持在提问时选择或搜索会话、群聊和联系人作为检索范围。

3. Ask WeChat
   - 用户可以直接问微信相关问题：
     - “产品讨论群最近在聊什么？”
     - “xxx最近有什么需要我跟进的？”
     - “上次陈宇说他什么时候来上海？”
   - 回答必须带来源：
     - 会话名
     - 时间范围
     - 引用片段
     - 本地导出文件路径或检索批次 ID

4. 已有对话
   - 用户可以从左侧历史列表打开之前的 agent 对话。
   - 对话页保留用户问题、模型回答、引用来源和本地导出批次。
   - 用户可以在已有对话中继续追问，沿用同一个微信检索上下文。

### 不做

- 不做完整聊天收发。
- 不做自动代发消息。
- 不做云端账号系统。
- 不做多设备同步。
- 不做全量长期上传。
- 不做复杂 agent marketplace。
- 不默认向模型发送原始聊天记录。

## 用户 Demo 脚本

1. 用户安装并打开桌面端。
2. App 进入 onboarding，检查 Mac 微信、Node.js、`wx-cli`、`opencli`。
3. App 引导用户授予必要权限，并说明每一步为什么需要。
4. 用户点击“初始化微信读取能力”。
5. 桌面端底层完成 `wx/opencli` 相关初始化，用户不需要接触终端命令。
6. 用户通过快捷键唤起菜单栏浮窗。
7. 主页默认聚焦 chatbox，用户提问：“产品讨论群最近在聊什么？”
8. App 调用 `opencli wx history`，导出局部聊天片段到本地临时目录。
9. AI 基于本地片段生成摘要，并展示引用来源。
10. 这次问答被保存到左侧历史对话中。
11. 用户稍后从左侧打开“产品讨论群摘要”。
12. App 恢复之前的问题、回答、引用和导出批次。
13. 用户在已有对话里继续追问：“把这几个主题按优先级排一下。”
14. App 沿用已有上下文，并按需补充调用 `opencli wx history`。

## Onboarding 设计

Onboarding 的目标是把所有命令行复杂度藏到底层，让非技术用户只看到清晰的授权和状态。

### 1. 欢迎与隐私边界

说明：

- 本工具只读取用户自己 Mac 上已经同步的微信聊天记录。
- 原始聊天记录默认留在本机。
- 如果使用云端模型，App 只发送为回答问题所需的局部片段，并在发送前展示确认。
- 群聊和联系人信息涉及他人隐私，分享分析结果前应脱敏。

### 2. 环境检查

检查：

- Mac 微信是否存在。
- 微信是否正在登录。
- Node.js 是否可用。
- `wx` 是否可用。
- `opencli` 是否可用。
- `~/.wx-cli` 是否存在。
- App 是否具备必要文件访问权限。

如果缺少 `wx-cli` 或 `opencli`，桌面端可以在用户确认后自动安装。

### 3. 权限引导

桌面端不能静默打开 macOS 完全磁盘访问权限，只能引导用户操作。

UI 应该提供：

- “打开系统设置”按钮。
- 当前权限状态。
- “我已授权，重新检查”按钮。
- 简短解释：这是为了读取本机微信数据，不是上传数据。

### 4. 微信读取初始化

用户点击确认后，桌面端执行底层初始化流程。

底层可能包括：

- 安装或更新 `@jackwener/wx-cli`。
- 安装或更新 `@jackwener/opencli`。
- 引导微信重签名。
- 打开或重启微信。
- 执行 `wx init`。
- 修复 `~/.wx-cli` 目录权限。
- 验证 `wx sessions`。
- 验证 `opencli wx sessions`。

这些操作不暴露给普通用户，但每一步 UI 都要显示可理解的状态，例如：

- “正在检查微信”
- “正在初始化本地读取能力”
- “需要你输入一次 Mac 密码”
- “正在验证是否能读取会话列表”

### 5. 模型与密钥配置

桌面端负责吃掉密钥配置细节。

可选模式：

- 用户输入自己的 OpenAI / Claude / Qwen API Key。
- 用户选择本地模型，例如 Ollama 或 LM Studio。
- Demo 阶段也可以使用开发者预置的临时 key，但必须避免把它暴露到前端代码或日志里。

密钥处理原则：

- 存入 macOS Keychain，不写入普通配置文件。
- 前端不直接持有长期密钥。
- 日志中不打印密钥。
- 导出诊断信息时自动隐藏密钥。

## 技术架构

### 推荐技术选型

- 桌面壳：Tauri
- 前端：React 或 Vue
- 本地数据库：SQLite
- 系统密钥：macOS Keychain
- 微信读取：`opencli wx ...` 优先，必要时回退到 `wx ...`
- 临时导出目录：`/tmp/wechat-agent-kit/exports/`
- App 数据目录：`~/Library/Application Support/WeChatAgent/`

### 分层

1. Desktop Shell
   - 菜单栏图标
   - 全局快捷键
   - 浮窗管理
   - 系统权限引导

2. Local Runtime
   - 检查 `wx/opencli`
   - 安装依赖
   - 调用本机命令
   - 管理临时导出文件
   - 处理 Keychain

3. WeChat Access Layer
   - `sessions`
   - `history`
   - `search`
   - `members`
   - `export`

4. AI Layer
   - 根据问题选择检索范围
   - 调用 `opencli wx` 导出局部上下文
   - 生成带引用回答
   - 管理当前 agent 对话上下文

5. Conversation Layer
   - 新对话
   - 历史对话
   - 引用来源
   - 导出批次

## 本地数据模型

### Agent Chat

```json
{
  "id": "chat_123",
  "title": "产品讨论群摘要",
  "scope": {
    "type": "conversation",
    "conversation": "产品讨论群",
    "since": "2026-04-13",
    "limit": 5000
  },
  "createdAt": "2026-05-13T00:00:00+08:00",
  "updatedAt": "2026-05-13T00:00:00+08:00"
}
```

### Chat Message

```json
{
  "id": "message_123",
  "chatId": "chat_123",
  "role": "assistant",
  "content": "最近一周主要在讨论线下见面、本地 AI 工具和项目进展。",
  "citations": [
    {
      "conversation": "产品讨论群",
      "messageTime": "2026-05-13T10:42:00+08:00",
      "exportId": "export_123"
    }
  ]
}
```

### Export Batch

```json
{
  "id": "export_123",
  "conversation": "产品讨论群",
  "since": "2026-04-13",
  "limit": 5000,
  "filePath": "/tmp/wechat-agent-kit/exports/export_123.json",
  "messageCount": 1320,
  "createdAt": "2026-05-13T00:00:00+08:00"
}
```

## 命令调用策略

桌面端统一走一个本地 command runner，不让前端拼接 shell 字符串。

推荐封装能力：

- `checkEnvironment()`
- `installDependencies()`
- `initializeWechatAccess()`
- `listSessions()`
- `exportHistory(conversation, since, limit)`
- `searchMessages(keyword, since, limit)`
- `listMembers(conversation)`
- `cleanupExports()`

命令调用优先级：

1. 优先使用 `opencli wx ...`。
2. 如果 `opencli` 不可用但 `wx` 可用，可以回退到 `wx ...`。
3. 如果两者都不可用，进入 onboarding 安装流程。

## 隐私与安全边界

- 默认只导出最近 6 个月或用户当前问题需要的时间范围。
- 默认限制消息条数，例如 5000 条以内。
- 大规模导出前必须二次确认。
- 临时导出文件默认可清理。
- AI 回答默认展示引用，不展示整段原始日志。
- 分享报告前提供脱敏提示。

## MVP 成功标准

这个 demo 成功不看功能数量，而看用户是否理解并愿意重复使用这条闭环：

1. 我可以从菜单栏快速问微信历史。
2. 它能给出可信答案，并告诉我依据来自哪里。
3. 我可以从左侧打开已有 agent 对话。
4. 已有对话能恢复问题、回答、引用和导出批次。
5. 我可以在已有对话里继续追问，而不是每次从零开始。

如果这条闭环成立，再继续做更完整的安装引导、MCP server、批量联系人整理和本地模型模式。

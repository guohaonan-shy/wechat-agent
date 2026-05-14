# 国内/中文友好的 agent 选择

截至 2026-05-11，下面这些工具值得关注。接这套微信本地读取能力时，优先选择能运行 shell 或支持 MCP 的工具。

## 最适合接入本方案

### Qwen Code

阿里 Qwen 的终端 agent，官方定位是“lives in your terminal”。它支持交互模式、headless 模式、IDE 集成，也支持 OpenAI/Anthropic/Gemini 兼容 API 和阿里云 Coding Plan。

适配方式：

```bash
qwen
# 然后让它运行 opencli wx ...
```

或：

```bash
qwen -p "用 opencli wx history 导出某群最近半年消息，并基于本地 JSON 总结"
```

适合原因：终端原生，能读写本地文件、能运行命令，和 `opencli wx` 的形态最匹配。

官方资料：

- https://github.com/QwenLM/qwen-code
- https://qwen.ai/qwencode

### Qoder / Qoder CLI

Qoder 是 agentic coding platform，提供 IDE、CLI、JetBrains 插件，并支持 MCP。Qoder CLI 有 Bash 工具、print 模式、MCP server 配置。

适配方式：

```bash
qodercli
# 在 TUI 中让它运行 opencli wx ...
```

或后续接 MCP：

```bash
qodercli mcp add wechat -- node /path/to/wechat-mcp-server.js
```

适合原因：CLI + MCP 都具备，后续可以直接把微信读取封装成 MCP 工具。

官方资料：

- https://qoder.com/
- https://docs.qoder.com/cli/using-cli

### Tencent CodeBuddy Code

腾讯云 CodeBuddy 有 IDE、插件和 CLI 三种形态。CodeBuddy Code 是终端工具，官方文档强调支持命令行、管道、脚本集成和 MCP。

适配方式：

```bash
codebuddy "运行 opencli wx sessions，然后帮我选择目标群"
```

或：

```bash
opencli wx history "群名" --since 2025-05-11 -n 5000 --json | codebuddy "基于输入总结群聊"
```

适合原因：CLI 原生，能接 Unix 管道和 MCP，适合给非技术用户做“中文 agent + 本地工具”方案。

官方资料：

- https://www.codebuddy.ai/docs/zh/cli/overview
- https://www.codebuddy.ai/docs/zh/ide/Introduction

## 可以作为桌面/IDE 入口

### TRAE

字节系 AI IDE，国内版官网介绍有 Builder 模式、多模型切换、代码解释、单测生成等能力；企业版页面也提到 IDE、插件、CLI 多形态。

适配判断：适合作为非技术用户的桌面入口，但是否能稳定直接调用 `opencli wx`，要看当前版本的终端/工具权限。若它的 agent 能运行 shell，就可以接入；否则需要通过 MCP 或外部脚本中转。

官方资料：

- https://www.trae.cn/sem
- https://www.trae.cn/enterprise

### 通义灵码

阿里云通义灵码有插件和 Lingma IDE，官方介绍里有“编程智能体”，具备自主规划、工程检索、文件编辑、终端等工具能力。

适配判断：如果使用 Lingma IDE/插件并允许终端工具，就能接 `opencli wx`；否则更适合做代码开发，不一定适合直接做本地微信数据分析入口。

官方资料：

- https://lingma.aliyun.com/
- https://help.aliyun.com/zh/lingma/

### Baidu Comate

百度文心快码 Comate 提供插件和独立 AI IDE，百度智能云文档提到智能体、多智能体协同、AI IDE 等能力。

适配判断：适合中文开发辅助；能否接入本方案取决于它是否允许 agent 调用本机 shell 或 MCP。若只能在 IDE 内补全/问答，则不如 Qwen Code / Qoder CLI / CodeBuddy Code 直接。

官方资料：

- https://comate.baidu.com/zh
- https://cloud.baidu.com/doc/COMATE/s/xlnvqe047

### CodeGeeX

智谱/清华背景的 AI 编程助手，偏 IDE 插件、代码补全、生成、解释和问答。

适配判断：如果只是插件补全能力，不是最适合读取本地微信数据的 agent 入口。可以作为写代码工具，但不是首选运行本地命令的执行器。

官方资料：

- https://codegeex.cn/

### MarsCode

MarsCode 提供 AI IDE、代码补全、生成、解释、Debug 和云开发环境。官网也提到 AI Plugin Development & Deployment。

适配判断：更偏云端/IDE 开发环境。如果目标是读取本机 Mac 微信数据库，云开发环境并不合适，除非它提供本地桌面端并允许本地 shell。

官方资料：

- https://www.marscode.com/

## 我的建议

给非技术朋友做产品化时分三档：

1. 最稳：本地安装包 + Codex / Claude Code / Qwen Code 这种终端 agent。
2. 中文友好：本地安装包 + Qwen Code / Qoder CLI / CodeBuddy Code。
3. 真正小白：做一个桌面端，把同步、权限、初始化、导出、分析提示词都包起来；agent 只负责生成最终分析。

这套微信能力的关键不是“哪个模型最强”，而是谁能安全、明确、可控地调用本机命令和本机文件。

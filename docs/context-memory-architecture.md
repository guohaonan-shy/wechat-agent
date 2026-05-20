# 微信上下文与 Memory 架构

## 背景

微信群记录会很快超过单次模型调用的有效上下文。一个群几千条消息已经足以让工具调用、流式输出和模型推理变慢；更大的群会进入几十万条消息的规模。

因此，桌面端不能把“全部聊天记录”直接当成一条 prompt 塞给模型。更稳的路径是：程序负责全量读取、索引、筛选和压缩，模型负责基于可追溯证据做判断和表达。

这个思路和 Codex 处理大型代码仓库类似。Codex 不会把几十万行代码一次性放进上下文，而是先用文件树、符号、搜索、片段读取和中间摘要缩小问题空间。

## 当前问题

直接把大量微信消息交给 agent 会遇到几类问题：

- 模型上下文太大，调用慢或超时。
- 模型不一定稳定触发工具调用，尤其是第三方 OpenAI-compatible provider。
- “全部/整体/完整分析”如果交给模型自己分页，模型可能只读一页就回答，或者读到一半停止。
- 微信消息不是 user/assistant 对话，不能直接映射成 LLM chat messages。
- 图片、文件、链接等消息需要保留 source 引用，而不是提前丢失。

## Codex 式处理方式

如果把一个群的全部消息交给 Codex 式 agent，合理流程是：

1. 明确任务目标，例如“分析 carczm 的群内形象”。
2. 程序化扫描全量 raw messages：
   - 消息数、时间范围、活跃时间段。
   - 目标人物发言数、被提及次数、互动对象。
   - 高频话题、关键词、连续对话窗口。
   - 高互动片段、争议片段、长消息片段。
3. 按时间、话题或参与者切 chunk。
4. 对每个 chunk 生成可追溯摘要。
5. 汇总成 evidence pack，再交给模型分析。
6. 模型回答时引用时间、发送人和内容概括，不暴露 message id、local_id、chatroom id。

核心原则是：全量扫描由 runtime 完成，模型只看被压缩和筛选后的证据材料。

## 三层 Memory

参考 Karpathy 的 LLM Wiki 和 OpenHuman 的 Obsidian-style Memory，底层可以分成三层：`raw`、`source`、`memory`。

### raw

不可变证据层。这里保存 wx-cli 的原始导出和附件。

示例：

```txt
memory-vault/
  raw/
    wechat/
      sessions/<session-id>/
        history/2026-05-20T14-20-12.json
        attachments/img_001.jpg
        attachments/img_002.jpg
```

规则：

- 只追加，不修改。
- 可作为审计来源。
- 不提交到 git。
- 可以作为本地 cache 复用。

### source

规范化材料层。把 raw 转成可读 Markdown，保留时间线和附件引用。

示例：

```md
# 坏姐姐在哪里 / 2026-05-20

## Timeline

- 20:41｜张三：今天训练吗？
- 20:42｜carczm：我晚点到。
- 20:43｜李四：[图片 img_001](../../raw/wechat/sessions/.../attachments/img_001.jpg)
```

规则：

- 微信消息是 evidence document，不是 LLM chat messages。
- 图片不先 OCR，不先总结；作为 source asset 引用。
- query-time 如果 provider 支持 multimodal，再把相关图片转成 base64 content part。

### memory

编译后的长期记忆层。这里不是流水账，而是面向查询的 wiki。

示例：

```txt
memory-vault/
  memory/
    groups/坏姐姐在哪里.md
    people/carczm.md
    topics/健身训练.md
    events/2026-05-20-训练讨论.md
```

每条 memory 都需要带 source refs：

```md
## carczm 的群内角色

carczm 经常以调侃和推进话题的方式参与讨论，在训练、聚会和日常互怼场景里更活跃。

Evidence:
- source/wechat/坏姐姐在哪里/2026-05-20.md#20:41-20:55
- source/wechat/坏姐姐在哪里/2026-05-18.md#22:10-22:38
```

## Runtime 策略

短期 MVP 不直接实现完整 vault，但 runtime 应按同样原则演进。

### 普通问题

默认只读取最近一页或相关时间窗口。

流程：

1. 定位会话。
2. 读取最近消息。
3. 如果问题可回答，直接回答。
4. 如果证据不足，说明当前可见记录不足。

### 全量问题

当用户明确要求“全部、所有、完整、整体、全面分析”时，不能依赖模型自己分页。

流程：

1. runtime 检测 full-scan 意图。
2. 程序自动用 `wx history --offset` 翻页读取。
3. 达到数据完整、消息上限或上下文预算后停止。
4. 先构造 summary/evidence pack，再交给模型。
5. 如果发生截断，回答必须明确说明范围限制。

### 大上下文分析

对于几千条以上消息，应避免把 raw messages 全部塞给模型。

推荐 pipeline：

```txt
wx history raw JSON
  -> normalize messages
  -> chunk by time/topic/person
  -> extract relevant windows
  -> build evidence pack
  -> model analysis
```

后续可以把 chunk summary 写入 `source` 和 `memory`，让相同群、相同人物的后续查询直接复用。

## 图片处理

图片应该作为多模态输入的一等公民，而不是默认 OCR。

流程：

1. `wx attachments` 列出图片附件。
2. `wx extract` 解密到本地 raw asset。
3. source Markdown 中写入图片引用。
4. query-time 按 provider 协议把相关图片转为 base64 data URL。

对于 text-only provider，可以退化为“视觉模型先生成图片描述，再给主模型”，但这只是 fallback，不是主路径。

## Provider 选择

OpenAI-compatible endpoint 只代表基础协议相似，不代表 agentic tool calling 完全一致。

经验判断：

- Qwen 适合当前工具调用和多模态方向。
- DeepSeek 可以作为文本分析模型，但不应强依赖它自己做工具规划。
- 如果使用 DeepSeek，runtime 应更 deterministic：先完成会话定位、full-scan、证据构造，再让 DeepSeek 分析。

因此，长期应把工具编排从模型手里拿回来，让模型只做“基于证据的分析和表达”。

## Cache

当前 `/tmp/wechat-agent-kit/exports/*.json` 已经接近 raw cache，但 runtime 还没有正式复用。

后续 cache key 应包含：

- session id
- since/until
- full-scan mode
- limit
- wx 数据 freshness，例如 session latest timestamp
- wx-cli version

如果 freshness 没变，可以复用 raw export 和 parsed context，避免重复导出。

## 结论

桌面端应该从“把微信记录塞给模型”演进为“本地 memory compiler”：

- raw 保存事实。
- source 保存可读材料。
- memory 保存长期可查询知识。
- runtime 负责检索、分页、压缩和 evidence pack。
- 模型负责判断、综合和表达。

这样才能支持大群、图片、长期记忆和可审计回答。

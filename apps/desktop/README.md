# 微信助手 Desktop

Tauri + React desktop demo for the WeChat Agent Kit.

## Run

Set the Qwen key in the same terminal that starts Tauri. Do not commit keys.

```bash
export QWEN_API_KEY="sk-..."
export QWEN_MODEL="qwen3.6-plus"
npm run tauri dev
```

Optional:

```bash
export QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
```

The app also accepts `DASHSCOPE_API_KEY`.

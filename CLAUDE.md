# CLAUDE.md

This file is the working guide for coding agents in this repository. Keep it current when the runtime, onboarding flow, privacy boundary, or build commands change.

## Project State

WeChat Agent Kit is a macOS local WeChat analysis toolkit. The repo now has two usable surfaces:

- Root CLI scripts for installing, verifying, and calling `opencli wx` / `wx`.
- A Tauri + React desktop demo in `apps/desktop` that handles onboarding, local initialization, local agent runtime execution, WeChat history tools, and streamed model answers.

The end-to-end flow has been run successfully on another machine. Treat the current code as an MVP that works, not as a pure design sketch.

## Core Principle

Chat data should stay on the user's Mac by default. The app may export local JSON snippets and send only the selected context needed for an answer to the configured model provider.

Do not add features that silently upload full chat history, bypass explicit consent for sensitive steps, or hide macOS permission / `sudo wx init` requirements.

## Repository Layout

- `README.md`: user-facing install and CLI overview.
- `install.sh`, `Install.command`: interactive macOS installer.
- `verify.sh`: local diagnostics for Node, npm, WeChat, `wx`, `opencli`, and session reads.
- `bin/wechat-agent`: small CLI wrapper. Prefers `opencli wx`, falls back to `wx`.
- `docs/agent-prompts.md`: prompt templates for shell-capable coding agents.
- `docs/privacy-and-consent.md`: privacy boundary and consent defaults.
- `docs/desktop-app-plan.md`: higher-level desktop / MCP product plan.
- `docs/desktop-mvp-demo.md`: desktop MVP product and architecture plan.
- `apps/desktop`: current Tauri + React implementation.
- `apps/desktop/agent-runtime`: Node/TypeScript OpenAI Agents SDK runtime used by the desktop app.

## Desktop App

Run from `apps/desktop`.

```bash
export QWEN_API_KEY="sk-..."
export QWEN_MODEL="qwen3.6-plus"
npm run tauri dev
```

Optional:

```bash
export QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
```

`DASHSCOPE_API_KEY` is also accepted. Do not commit keys.

The agent runtime uses `@openai/agents` and is executed through local `tsx`; Node.js 22+ is the safest target because the Agents SDK requires Node 22 or later.

Useful checks:

```bash
npm run build
npm run tauri dev
npm run tauri build
```

The Tauri dev URL is `http://localhost:1420`, configured in `apps/desktop/src-tauri/tauri.conf.json`.

## Runtime Architecture

Frontend:

- `apps/desktop/src/App.tsx` owns all current UI state.
- Onboarding state is stored under `wechat-agent-onboarding-complete` in `localStorage`.
- Chat history is stored under `wechat-agent-chats` in `localStorage`.
- Agent streaming is handled through Tauri events: `agent:status`, `agent:tool`, `chat:delta`, `chat:error`, and `chat:done`.

Backend:

- `apps/desktop/src-tauri/src/lib.rs` exposes all Tauri commands.
- `diagnose_environment` checks macOS, Node, npm, WeChat.app, `wx`, `opencli`, `~/.wx-cli`, and readable WeChat data paths.
- `check_local_init_status` validates `~/.wx-cli/config.json`, `~/.wx-cli/all_keys.json`, and `wx sessions -n 1 --json`.
- `run_wx_init` writes `~/.wx-cli/init.sh`, opens Terminal with AppleScript, runs the wx-cli recommended initialization flow, fixes ownership, and verifies `wx sessions`.
- `list_sessions` runs `opencli wx sessions -n 20 --json` when available, falls back to `wx sessions -n 20 --json`, and parses several possible JSON shapes.
- `export_history` runs `opencli wx history` when available, falls back to `wx history`, clamps the limit to `1..=5000`, and writes JSON to `/tmp/wechat-agent-kit/exports`.
- `ask_qwen` and `ask_qwen_stream` call an OpenAI-compatible DashScope endpoint with a compact local context.
- `ask_agent_runtime` starts `apps/desktop/agent-runtime/wechat-agent.ts`, sends the user question over stdin, parses JSONL runtime events from stdout, and relays them to the UI.

Current command runtime: desktop and CLI now both prefer `opencli wx` and fall back to `wx` if `opencli` is not installed.

## Current Agent Flow

1. User finishes onboarding.
2. User asks a question.
3. Frontend calls `ask_agent_runtime`.
4. Rust starts the local TypeScript agent runtime and relays JSONL events.
5. The runtime preloads recent chat names and gives the agent a high-confidence session hint, candidate sessions, or the recent session list.
6. The single OpenAI Agents SDK agent decides when to call WeChat tools.
7. `export_wechat_history` returns `wechat.history.v1`: normalized messages, total count, current page count, time range, pagination metadata, truncation status, and a compact `llmContext`.
8. History pagination defaults to `pageFrom=latest`: page 1 returns the latest messages while preserving chronological order inside the page. If `pagination.hasNextPage` is true, the agent should call `export_wechat_history` again with `offset=pagination.nextOffset` and `pageFrom=latest` before making whole-history claims.
9. Agent tools call `opencli wx ...` when available, falling back to `wx ...`.
10. History exports are bounded and written under `/tmp/wechat-agent-kit/exports`.
11. The runtime streams tool status and final text deltas back to React.
12. Frontend renders a compact activity timeline and stores the conversation in `localStorage`.

This is the main target area for the next agent runtime optimization pass.

## Runtime Optimization Backlog

Prioritize these before adding broad new features:

1. Expand the agent runtime with normalized error types, cancellation, and command telemetry.
2. Move from one fixed agent to skill/tool routing once the tool set grows.
3. Improve retrieval scope planning beyond the current agent instruction default of recent 6 months.
4. Add map-reduce style whole-history analysis over paginated `wechat.history.v1` pages.
5. Return structured citations from retrieved messages instead of only the export file path.
6. Move conversation persistence out of `localStorage` into a local app data store when the chat model stabilizes.
7. Add cancellation and cleanup for in-flight streams when users switch chats or delete a conversation.
8. Add broader tests around history context compaction, stream edge cases, and command error normalization.

## Privacy And Safety Rules

- Keep default exports bounded. The agent runtime clamps `export_wechat_history.limit` to max `10000` messages and paginates tool responses; the legacy Rust export path still clamps to `5000`.
- Keep exports under `/tmp/wechat-agent-kit/exports` unless the user explicitly chooses another location.
- Never log API keys.
- Never put long-lived keys in frontend code or committed files.
- Keep sensitive operations explicit: full disk access, WeChat re-signing, `sudo wx init`, large exports, and cloud-model submission.
- For model answers, avoid exposing internal IDs, raw file paths, usernames, chatroom IDs, message IDs, or implementation details unless the user asks for diagnostics.

## Development Notes

- Prefer existing Tauri command patterns before adding a new abstraction.
- Keep shell execution argument-based where possible. Do not build shell strings for user-provided session names.
- If a command has to open macOS UI or Terminal, keep that path explicit and user-initiated.
- Do not touch `design/app.pen` unless the task is specifically about the Pencil design file.
- Use ASCII for code/docs unless editing existing Chinese copy. Chinese user-facing copy is already part of the product and is fine.

## Known Gaps

- Qwen base URL and model are environment-driven only; there is no in-app model/key settings screen yet.
- `localStorage` persistence is convenient for demo only.
- Citations are currently export-batch level, not message-level.
- The new TypeScript agent runtime is type-checked manually for now; it is not yet part of `npm run build`.
- The older Rust `ask_qwen_stream` path still exists as a fallback/legacy path but the UI now calls `ask_agent_runtime`.

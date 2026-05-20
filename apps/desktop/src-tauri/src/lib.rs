use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckItem {
    key: String,
    label: String,
    ok: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnoseResult {
    ok: bool,
    checks: Vec<CheckItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitCheckResult {
    config_ready: bool,
    query_ready: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    ok: bool,
    status: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    title: String,
    subtitle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    ok: bool,
    file: String,
    session: String,
    since: String,
    limit: u32,
    bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskRequest {
    question: String,
    context_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Citation {
    label: String,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskResponse {
    answer: String,
    citations: Vec<Citation>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamPayload {
    stream_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamDeltaPayload {
    stream_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload {
    stream_id: String,
    message: String,
}

fn command_path(name: &str) -> Option<String> {
    let output = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {}", shell_escape(name))])
        .output()
        .ok()?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    } else {
        None
    }
}

fn shell_escape(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .collect()
}

fn shell_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\\''"))
}

fn applescript_string(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn run_command(program: &str, args: &[&str]) -> Result<CommandResult, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run {program}: {err}"))?;

    Ok(CommandResult {
        ok: output.status.success(),
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_command_in_dir(program: &str, args: &[&str], dir: &Path) -> Result<CommandResult, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|err| format!("failed to run {program}: {err}"))?;

    Ok(CommandResult {
        ok: output.status.success(),
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn wx_cli_dir() -> PathBuf {
    home_dir().join(".wx-cli")
}

fn run_wx_command(args: &[&str]) -> Result<CommandResult, String> {
    let program = command_path("wx").ok_or_else(|| "缺少 wx，请先安装 wx-cli。".to_string())?;
    let dir = wx_cli_dir();
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    run_command_in_dir(&program, args, &dir)
}

#[tauri::command]
fn diagnose_environment() -> DiagnoseResult {
    let wechat_app = Path::new("/Applications/WeChat.app");
    let wx_cli_dir = wx_cli_dir();
    let checks = vec![
        CheckItem {
            key: "macos".to_string(),
            label: "macOS".to_string(),
            ok: cfg!(target_os = "macos"),
            detail: if cfg!(target_os = "macos") {
                "当前运行在 macOS".to_string()
            } else {
                "桌面端 MVP 只支持 macOS".to_string()
            },
        },
        cmd_check("node", "Node.js"),
        cmd_check("npm", "npm"),
        CheckItem {
            key: "wechat".to_string(),
            label: "Mac 微信".to_string(),
            ok: wechat_app.exists(),
            detail: "/Applications/WeChat.app".to_string(),
        },
        cmd_check("wx", "wx-cli"),
        CheckItem {
            key: "wxCliDir".to_string(),
            label: "~/.wx-cli".to_string(),
            ok: wx_cli_dir.exists(),
            detail: wx_cli_dir.display().to_string(),
        },
        wechat_data_access_check(),
    ];
    let ok = checks.iter().all(|check| check.ok);
    DiagnoseResult { ok, checks }
}

fn cmd_check(cmd: &str, label: &str) -> CheckItem {
    match command_path(cmd) {
        Some(path) => CheckItem {
            key: cmd.to_string(),
            label: label.to_string(),
            ok: true,
            detail: path,
        },
        None => CheckItem {
            key: cmd.to_string(),
            label: label.to_string(),
            ok: false,
            detail: format!("缺少 {cmd}"),
        },
    }
}

fn wechat_data_access_check() -> CheckItem {
    if let Some(path) = detect_wechat_db_dir() {
        return CheckItem {
            key: "wechatDataAccess".to_string(),
            label: "微信数据访问".to_string(),
            ok: true,
            detail: path.display().to_string(),
        };
    }

    let home = home_dir();
    let candidates = wechat_data_roots(&home);
    for path in candidates.iter().filter(|path| path.exists()) {
        if fs::read_dir(path).is_ok() {
            return CheckItem {
                key: "wechatDataAccess".to_string(),
                label: "微信数据访问".to_string(),
                ok: true,
                detail: path.display().to_string(),
            };
        }
    }

    CheckItem {
        key: "wechatDataAccess".to_string(),
        label: "微信数据访问".to_string(),
        ok: false,
        detail: "尚未检测到可读取的微信数据目录，请授予完全磁盘访问后重试。".to_string(),
    }
}

fn wechat_data_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Library/Containers/com.tencent.xinWeChat/Data/Documents"),
        home.join(
            "Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat",
        ),
        home.join("Library/Application Support/com.tencent.xinWeChat"),
        home.join("Library/Containers/com.tencent.xinWeChat"),
    ]
}

fn detect_wechat_db_dir() -> Option<PathBuf> {
    let home = home_dir();
    let xwechat_files =
        home.join("Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files");

    find_db_storage_under(&xwechat_files, 2).or_else(|| {
        wechat_data_roots(&home)
            .into_iter()
            .filter_map(|root| find_db_storage_under(&root, 4))
            .next()
    })
}

fn find_db_storage_under(root: &Path, max_depth: usize) -> Option<PathBuf> {
    if !root.exists() || max_depth == 0 {
        return None;
    }

    let mut best: Option<(PathBuf, u64)> = None;
    collect_db_storage_dirs(root, max_depth, &mut best);
    best.map(|(path, _)| path)
}

fn collect_db_storage_dirs(root: &Path, depth_left: usize, best: &mut Option<(PathBuf, u64)>) {
    if depth_left == 0 {
        return;
    }

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        if path.file_name().and_then(|name| name.to_str()) == Some("db_storage") {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .map(|elapsed| u64::MAX - elapsed.as_secs())
                .unwrap_or(0);

            match best {
                Some((_, current_modified)) if *current_modified >= modified => {}
                _ => *best = Some((path, modified)),
            }
            continue;
        }

        collect_db_storage_dirs(&path, depth_left - 1, best);
    }
}

fn tail_non_empty_lines(path: &Path, limit: usize) -> String {
    fs::read_to_string(path)
        .ok()
        .map(|content| {
            let mut lines: Vec<_> = content
                .lines()
                .map(str::trim)
                .map(sanitize_terminal_line)
                .filter(|line| !line.is_empty())
                .collect();
            let keep_from = lines.len().saturating_sub(limit);
            lines.drain(0..keep_from);
            lines.join("\n")
        })
        .filter(|content| !content.is_empty())
        .unwrap_or_default()
}

fn sanitize_terminal_line(line: &str) -> String {
    let mut output = String::new();
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek().copied() == Some('\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }

        if !ch.is_control() {
            output.push(ch);
        }
    }

    output.trim().to_string()
}

#[tauri::command]
fn check_local_init_status() -> InitCheckResult {
    let wx_cli_dir = wx_cli_dir();
    let config_path = wx_cli_dir.join("config.json");
    let keys_path = wx_cli_dir.join("all_keys.json");
    let init_log_path = wx_cli_dir.join("init.log");

    if !wx_cli_dir.exists() {
        return InitCheckResult {
            config_ready: false,
            query_ready: false,
            detail: format!("尚未创建 {}，需要执行一次初始化。", wx_cli_dir.display()),
        };
    }

    if !config_path.exists() {
        return InitCheckResult {
            config_ready: false,
            query_ready: false,
            detail: "尚未写入微信数据目录配置，需要执行一次初始化。".to_string(),
        };
    }

    if !keys_path.exists() {
        let init_log = tail_non_empty_lines(&init_log_path, 5);
        let detail = if init_log.is_empty() {
            "尚未生成 all_keys.json。请在 Terminal 中确认 sudo wx init 已成功完成；如果失败，请按 Terminal 里的 wx-cli 错误处理后重新初始化。".to_string()
        } else {
            format!(
                "尚未生成 all_keys.json。最近初始化日志已记录，可展开查看。[[INIT_LOG]]{}",
                init_log
            )
        };
        return InitCheckResult {
            config_ready: false,
            query_ready: false,
            detail,
        };
    }

    match run_wx_command(&["sessions", "-n", "1", "--json"]) {
        Ok(result) if result.ok => InitCheckResult {
            config_ready: true,
            query_ready: true,
            detail: "已检测到可用的本机微信读取能力。".to_string(),
        },
        Ok(result) => {
            let detail = if result.stderr.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                result.stderr.trim().to_string()
            };
            InitCheckResult {
                config_ready: true,
                query_ready: false,
                detail: if detail.is_empty() {
                    "本机配置已存在，但微信会话读取检查没有通过。".to_string()
                } else {
                    detail
                },
            }
        }
        Err(message) => InitCheckResult {
            config_ready: true,
            query_ready: false,
            detail: message,
        },
    }
}

#[tauri::command]
fn install_cli_tools() -> Result<CommandResult, String> {
    run_command("npm", &["install", "-g", "@jackwener/wx-cli"])
}

#[tauri::command]
fn open_full_disk_access_settings() -> Result<CommandResult, String> {
    run_command(
        "open",
        &["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
    )
}

#[tauri::command]
fn run_wx_init() -> Result<CommandResult, String> {
    let wx_path =
        command_path("wx").ok_or_else(|| "缺少 wx 命令，请先安装 wx-cli。".to_string())?;
    let wx_cli_dir = wx_cli_dir();
    let init_log_path = wx_cli_dir.join("init.log");
    let init_script_path = wx_cli_dir.join("init.sh");

    fs::create_dir_all(&wx_cli_dir)
        .map_err(|err| format!("创建 {} 失败：{err}", wx_cli_dir.display()))?;

    let init_script = format!(
        r#"#!/bin/zsh
cd {dir}
LOG={log}
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1
clear
OWNER_USER=$(id -un)
OWNER_GROUP=$(id -gn)
echo "微信助手正在按 wx-cli 官方推荐流程初始化。"
echo
echo "1/5 重签名 WeChat，允许 wx-cli 扫描本机微信内存。"
if ! sudo codesign --force --deep --sign - /Applications/WeChat.app; then
  sudo codesign --remove-signature "/Applications/WeChat.app/Contents/Frameworks/vlc_plugins/librtp_mpeg4_plugin.dylib" || true
  sudo codesign --force --deep --sign - /Applications/WeChat.app
fi

echo
echo "2/5 重置 WeChat 的旧 macOS 隐私授权记录。"
for service in ScreenCapture Camera Microphone AppleEvents AddressBook SystemPolicyDocumentsFolder SystemPolicyDownloadsFolder SystemPolicyDesktopFolder; do
  tccutil reset "$service" com.tencent.xinWeChat >/dev/null 2>&1 || true
done

echo
echo "3/5 重启 WeChat。请等待微信完全登录。"
killall WeChat >/dev/null 2>&1 || true
open /Applications/WeChat.app
echo
echo "微信完全登录后，在这个 Terminal 窗口按回车继续。"
read _

echo
echo "4/5 执行 sudo wx init，并修复本机配置权限。"
sudo {wx} init
INIT_STATUS=$?
echo
echo "修复 ~/.wx-cli 文件权限，确保后续 App 可直接读取。"
sudo /usr/sbin/chown -R "$OWNER_USER:$OWNER_GROUP" {dir}
if [ "$INIT_STATUS" -ne 0 ]; then
  echo
  echo "wx init 未成功完成。请根据上方错误处理后，再回到微信助手重新开始初始化。"
  exit "$INIT_STATUS"
fi

echo
echo "5/5 验证 wx sessions。"
{wx} daemon stop >/dev/null 2>&1 || true
{wx} sessions -n 1
VERIFY_STATUS=$?
echo
if [ "$VERIFY_STATUS" -eq 0 ]; then
  echo "初始化和权限修复已完成。请回到微信助手点击重新检查。"
else
  echo "wx sessions 验证失败。请把上方错误发给开发者，或重新开始初始化。"
fi
exit "$VERIFY_STATUS"
"#,
        dir = shell_quote(&wx_cli_dir.display().to_string()),
        log = shell_quote(&init_log_path.display().to_string()),
        wx = shell_quote(&wx_path),
    );
    fs::write(&init_script_path, init_script)
        .map_err(|err| format!("写入 {} 失败：{err}", init_script_path.display()))?;
    run_command(
        "chmod",
        &["+x", init_script_path.to_string_lossy().as_ref()],
    )?;

    let terminal_script = format!("{}", shell_quote(&init_script_path.display().to_string()));
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        applescript_string(&terminal_script)
    );
    let result = run_command("osascript", &["-e", script.as_str()])?;
    if !result.ok {
        let message = if result.stderr.trim().is_empty() {
            result.stdout.trim().to_string()
        } else {
            result.stderr.trim().to_string()
        };
        return Err(if message.is_empty() {
            "初始化命令没有成功完成。".to_string()
        } else {
            message
        });
    }

    Ok(result)
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionSummary>, String> {
    let result = run_wx_command(&["sessions", "-n", "20", "--json"])?;
    if !result.ok {
        return Err(result.stderr.trim().to_string());
    }

    Ok(parse_sessions(&result.stdout))
}

fn parse_sessions(output: &str) -> Vec<SessionSummary> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(output) {
        let array = value
            .as_array()
            .cloned()
            .or_else(|| value.get("sessions").and_then(|v| v.as_array().cloned()))
            .unwrap_or_default();

        let sessions: Vec<_> = array
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let id = session_field(
                    item,
                    &["id", "username", "userName", "wxid", "roomId", "room_id"],
                )
                .unwrap_or_else(|| format!("session_{index}"));
                let title = session_field(
                    item,
                    &[
                        "name",
                        "chat",
                        "title",
                        "remark",
                        "displayName",
                        "display_name",
                        "nickname",
                        "nickName",
                        "alias",
                        "conversationName",
                        "sessionName",
                        "contactName",
                    ],
                )
                .or_else(|| {
                    if id.starts_with("session_") {
                        None
                    } else {
                        Some(id.clone())
                    }
                })
                .unwrap_or_else(|| "未命名会话".to_string());
                SessionSummary {
                    id,
                    title,
                    subtitle: "来自 wx sessions".to_string(),
                }
            })
            .collect();

        if !sessions.is_empty() {
            return sessions;
        }
    }

    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(SessionSummary {
                    id: trimmed.to_string(),
                    title: trimmed.to_string(),
                    subtitle: "来自 wx sessions 输出".to_string(),
                })
            }
        })
        .take(20)
        .collect()
}

fn session_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|field| field.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    for key in [
        "contact",
        "user",
        "profile",
        "conversation",
        "session",
        "room",
    ] {
        if let Some(nested) = value.get(key) {
            if let Some(text) = session_field(nested, keys) {
                return Some(text);
            }
        }
    }

    None
}

#[tauri::command]
fn export_history(session: String, since: String, limit: u32) -> Result<ExportResult, String> {
    let limit = limit.min(5000).max(1).to_string();
    let history_args = [
        "history", &session, "--since", &since, "-n", &limit, "--json",
    ];
    let result = run_wx_command(&history_args)?;
    if !result.ok {
        return Err(result.stderr.trim().to_string());
    }

    let dir = Path::new("/tmp/wechat-agent-kit/exports");
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let safe_session = session
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let file = dir.join(format!(
        "{}-{}.json",
        safe_session.trim_matches('-'),
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    fs::write(&file, result.stdout.as_bytes()).map_err(|err| err.to_string())?;

    Ok(ExportResult {
        ok: true,
        file: file.display().to_string(),
        session,
        since,
        limit: limit.parse().unwrap_or(5000),
        bytes: result.stdout.len(),
    })
}

fn read_llm_context(context_file: &Option<String>) -> String {
    match context_file {
        Some(file) => fs::read_to_string(file)
            .map(|content| build_llm_context(&content))
            .unwrap_or_else(|_| "未能读取本地导出文件。".to_string()),
        None => "没有提供本地聊天摘录。".to_string(),
    }
}

fn build_llm_context(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.chars().take(32_000).collect();
    };

    let chat = value
        .get("chat")
        .and_then(|field| field.as_str())
        .unwrap_or("当前会话");
    let mut lines = vec![format!("会话：{chat}")];

    if let Some(messages) = value.get("messages").and_then(|field| field.as_array()) {
        for item in messages.iter().take(900) {
            let time = item
                .get("time")
                .and_then(|field| field.as_str())
                .unwrap_or("未知时间");
            let sender = item
                .get("sender")
                .and_then(|field| field.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("未知发送者");
            let content = item
                .get("content")
                .and_then(|field| field.as_str())
                .or_else(|| item.get("summary").and_then(|field| field.as_str()))
                .unwrap_or("")
                .trim();
            let message_type = item
                .get("type")
                .and_then(|field| field.as_str())
                .unwrap_or("消息");

            if content.is_empty() {
                continue;
            }

            lines.push(format!("[{time}] {sender}（{message_type}）：{content}"));
        }
    }

    lines.join("\n").chars().take(32_000).collect()
}

fn qwen_system_prompt() -> &'static str {
    "你是一个本机微信记录分析助手。请基于提供的聊天摘录回答用户问题，回答要简洁、具体，并尽量引用可核对的消息内容或发送人表达作为依据。不要提及 JSON、系统设定、上下文片段、内部记录、消息 ID、local_id、username、chatroom id 或文件路径；如果需要指代消息，用发送人、时间和消息内容概括替代。若当前可见聊天记录不足以支持结论，请自然说明“当前可见聊天记录不足以判断”，不要说“受限于系统设定”。"
}

#[tauri::command]
async fn ask_qwen(request: AskRequest) -> Result<AskResponse, String> {
    let api_key = env::var("QWEN_API_KEY")
        .or_else(|_| env::var("DASHSCOPE_API_KEY"))
        .map_err(|_| "缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY。".to_string())?;
    let base_url = env::var("QWEN_BASE_URL")
        .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string());
    let model = env::var("QWEN_MODEL").unwrap_or_else(|_| "qwen3.6-plus".to_string());
    let context = read_llm_context(&request.context_file);

    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": qwen_system_prompt()
            },
            {
                "role": "user",
                "content": format!("问题：{}\n\n本地聊天摘录：\n{}", request.question, context)
            }
        ],
        "temperature": 0.2
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(value.to_string());
    }

    let answer = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("模型没有返回文本。")
        .to_string();

    Ok(AskResponse {
        answer,
        citations: request
            .context_file
            .map(|file| {
                vec![Citation {
                    label: "本地导出批次".to_string(),
                    source: file,
                }]
            })
            .unwrap_or_default(),
    })
}

#[tauri::command]
async fn ask_qwen_stream(
    app: AppHandle,
    request: AskRequest,
    stream_id: String,
) -> Result<AskResponse, String> {
    let api_key = env::var("QWEN_API_KEY")
        .or_else(|_| env::var("DASHSCOPE_API_KEY"))
        .map_err(|_| "缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY。".to_string())?;
    let base_url = env::var("QWEN_BASE_URL")
        .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string());
    let model = env::var("QWEN_MODEL").unwrap_or_else(|_| "qwen3.6-plus".to_string());
    let context = read_llm_context(&request.context_file);
    let citations = request
        .context_file
        .clone()
        .map(|file| {
            vec![Citation {
                label: "本地导出批次".to_string(),
                source: file,
            }]
        })
        .unwrap_or_default();

    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": qwen_system_prompt()
            },
            {
                "role": "user",
                "content": format!("问题：{}\n\n本地聊天摘录：\n{}", request.question, context)
            }
        ],
        "temperature": 0.2,
        "stream": true
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let value: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
        let message = value.to_string();
        let _ = app.emit(
            "chat:error",
            StreamErrorPayload {
                stream_id,
                message: message.clone(),
            },
        );
        return Err(message);
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut answer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(bytes) => bytes,
            Err(err) => {
                let message = err.to_string();
                let _ = app.emit(
                    "chat:error",
                    StreamErrorPayload {
                        stream_id,
                        message: message.clone(),
                    },
                );
                return Err(message);
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        buffer = buffer.replace("\r\n", "\n");

        while let Some(index) = buffer.find("\n\n") {
            let event = buffer[..index].to_string();
            buffer = buffer[index + 2..].to_string();

            for line in event.lines() {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    let _ = app.emit(
                        "chat:done",
                        StreamPayload {
                            stream_id: stream_id.clone(),
                        },
                    );
                    return Ok(AskResponse { answer, citations });
                }

                if let Some(delta) = stream_delta(data) {
                    answer.push_str(&delta);
                    let _ = app.emit(
                        "chat:delta",
                        StreamDeltaPayload {
                            stream_id: stream_id.clone(),
                            delta,
                        },
                    );
                }
            }
        }
    }

    let _ = app.emit(
        "chat:done",
        StreamPayload {
            stream_id: stream_id.clone(),
        },
    );
    Ok(AskResponse { answer, citations })
}

fn stream_delta(data: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(data).ok()?;
    value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(|content| content.as_str())
        .filter(|content| !content.is_empty())
        .map(ToString::to_string)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            diagnose_environment,
            check_local_init_status,
            install_cli_tools,
            open_full_disk_access_settings,
            run_wx_init,
            list_sessions,
            export_history,
            ask_qwen,
            ask_qwen_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

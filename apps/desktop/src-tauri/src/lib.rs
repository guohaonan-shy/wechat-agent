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

fn wx_runner_args<'a>(args: &'a [&'a str]) -> Result<(String, Vec<&'a str>), String> {
    if command_path("opencli").is_some() {
        let mut full_args = vec!["wx"];
        full_args.extend_from_slice(args);
        Ok(("opencli".to_string(), full_args))
    } else if command_path("wx").is_some() {
        Ok(("wx".to_string(), args.to_vec()))
    } else {
        Err("缺少 opencli / wx，请先安装本地工具。".to_string())
    }
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[tauri::command]
fn diagnose_environment() -> DiagnoseResult {
    let wechat_app = Path::new("/Applications/WeChat.app");
    let wx_cli_dir = home_dir().join(".wx-cli");
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
        cmd_check("opencli", "opencli"),
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
    let home = home_dir();
    let candidates = [
        home.join(
            "Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat",
        ),
        home.join("Library/Containers/com.tencent.xinWeChat/Data/Documents"),
        home.join("Library/Application Support/com.tencent.xinWeChat"),
        home.join("Library/Containers/com.tencent.xinWeChat"),
    ];

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

#[tauri::command]
fn install_cli_tools() -> Result<CommandResult, String> {
    run_command(
        "npm",
        &["install", "-g", "@jackwener/opencli", "@jackwener/wx-cli"],
    )
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
    if command_path("wx").is_none() {
        return Err("缺少 wx 命令，请先安装 wx-cli。".to_string());
    }

    let wx_cli_dir = home_dir().join(".wx-cli");
    let user = env::var("USER").unwrap_or_else(|_| "root".to_string());
    let group = run_command("id", &["-gn"])
        .ok()
        .filter(|result| result.ok)
        .map(|result| result.stdout.trim().to_string())
        .filter(|group| !group.is_empty())
        .unwrap_or_else(|| "staff".to_string());
    let command = format!(
        "wx init; if [ -d {dir} ]; then /usr/sbin/chown -R {user}:{group} {dir}; fi",
        dir = shell_quote(&wx_cli_dir.display().to_string()),
        user = shell_quote(&user),
        group = shell_quote(&group),
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        applescript_string(&command)
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
    let (program, args) = wx_runner_args(&["sessions", "-n", "20", "--json"])?;
    let result = run_command(&program, &args)?;
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
                    subtitle: "来自 opencli wx sessions".to_string(),
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
    let (program, args) = wx_runner_args(&history_args)?;
    let result = run_command(&program, &args)?;
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

#[tauri::command]
async fn ask_qwen(request: AskRequest) -> Result<AskResponse, String> {
    let api_key = env::var("QWEN_API_KEY")
        .or_else(|_| env::var("DASHSCOPE_API_KEY"))
        .map_err(|_| "缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY。".to_string())?;
    let base_url = env::var("QWEN_BASE_URL")
        .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string());
    let model = env::var("QWEN_MODEL").unwrap_or_else(|_| "qwen3.6-plus".to_string());
    let context = match &request.context_file {
        Some(file) => fs::read_to_string(file)
            .map(|content| content.chars().take(32_000).collect::<String>())
            .unwrap_or_else(|_| "未能读取本地导出文件。".to_string()),
        None => "没有提供本地导出上下文。".to_string(),
    };

    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是一个本机微信记录分析助手。只基于用户提供的本地上下文回答；如果上下文不足，明确说明不足。回答要简洁，并尽量给出可核对依据。"
            },
            {
                "role": "user",
                "content": format!("问题：{}\n\n本地微信上下文：\n{}", request.question, context)
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
    let context = match &request.context_file {
        Some(file) => fs::read_to_string(file)
            .map(|content| content.chars().take(32_000).collect::<String>())
            .unwrap_or_else(|_| "未能读取本地导出文件。".to_string()),
        None => "没有提供本地导出上下文。".to_string(),
    };
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
                "content": "你是一个本机微信记录分析助手。只基于用户提供的本地上下文回答；如果上下文不足，明确说明不足。回答要简洁，并尽量给出可核对依据。"
            },
            {
                "role": "user",
                "content": format!("问题：{}\n\n本地微信上下文：\n{}", request.question, context)
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

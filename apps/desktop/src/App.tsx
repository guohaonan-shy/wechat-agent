import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  CircleCheck,
  Download,
  HardDrive,
  KeyRound,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  SearchCheck,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Terminal,
  Trash2,
  TriangleAlert,
  UserSearch,
  Users,
  Wrench,
} from "lucide-react";
import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type OnboardingStep = "welcome" | "setup" | "permission" | "confirm" | "ready";
type View = "onboarding" | "home" | "chat";
type SetupPhase = "idle" | "checking" | "installing" | "verifying" | "ready" | "needsAttention" | "error";
type SetupCheckStatus = "pending" | "checking" | "ready" | "blocked";
type PermissionStatus = "idle" | "checking" | "granted" | "blocked" | "error";
type InitStatus = "idle" | "checking" | "ready" | "needsInit" | "initializing" | "waitingExternal" | "error";
type InitProgressStatus = "pending" | "checking" | "ready" | "blocked";

type CheckItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

type DiagnoseResult = {
  ok: boolean;
  checks: CheckItem[];
};

type InitCheckResult = {
  configReady: boolean;
  queryReady: boolean;
  detail: string;
};

type SetupCheck = {
  key: string;
  label: string;
  detail: string;
  status: SetupCheckStatus;
};

type InitProgressStep = {
  key: "config" | "query" | "finish";
  label: string;
  detail: string;
  status: InitProgressStatus;
};

type SessionSummary = {
  id: string;
  title: string;
  subtitle: string;
};

type ExportResult = {
  ok: boolean;
  file: string;
  session: string;
  since: string;
  limit: number;
  bytes: number;
};

type Citation = {
  label: string;
  source: string;
};

type ChatDeltaPayload = {
  streamId: string;
  delta: string;
};

type ChatErrorPayload = {
  streamId: string;
  message: string;
};

type ChatCancelledPayload = {
  streamId: string;
  message: string;
};

type AgentStatusPayload = {
  streamId: string;
  message: string;
};

type AgentToolPayload = {
  streamId: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  summary?: string;
  input?: Record<string, unknown>;
  citation?: Citation;
};

type AgentActivity = {
  id: string;
  kind: "status" | "tool";
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
  tool?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  pending?: boolean;
  thinkingStep?: string;
  activities?: AgentActivity[];
};

type AgentChat = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const MIN_STATUS_DELAY_MS = 650;
const SETUP_CHECKING_DELAY_MS = 620;
const SETUP_RESULT_DELAY_MS = 180;
const SETUP_DEPENDENCY_KEYS = ["node", "npm", "wechat", "wx", "opencli"];
const ONBOARDING_COMPLETE_KEY = "wechat-agent-onboarding-complete";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

async function withMinimumDelay<T>(promise: Promise<T>, delay = MIN_STATUS_DELAY_MS) {
  const [result] = await Promise.all([promise, sleep(delay)]);
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function App() {
  const [view, setView] = useState<View>(() =>
    localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true" ? "home" : "onboarding",
  );
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const [setupChecksState, setSetupChecksState] = useState<SetupCheck[]>(() =>
    setupChecks(null, "idle", "准备检查本地环境"),
  );
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [setupLog, setSetupLog] = useState("准备检查本地环境");
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>("idle");
  const [permissionDetail, setPermissionDetail] = useState("等待检查权限状态");
  const [initStatus, setInitStatus] = useState<InitStatus>("idle");
  const [initDetail, setInitDetail] = useState("等待检查初始化状态");
  const [initProgress, setInitProgress] = useState<InitProgressStep[]>(() => createInitProgress());
  const [busy, setBusy] = useState(false);
  const [permissionOpened, setPermissionOpened] = useState(false);
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [input, setInput] = useState("");
  const [activeStream, setActiveStream] = useState<{ streamId: string; chatId: string; messageId: string } | null>(null);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? chats[0],
    [activeChatId, chats],
  );

  useEffect(() => {
    const stored = localStorage.getItem("wechat-agent-chats");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as AgentChat[];
        const userChats = parsed.filter((chat) => !chat.id.startsWith("seed_"));
        if (userChats.length > 0) {
          setChats(userChats);
          setActiveChatId(userChats[0].id);
          if (localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true") {
            setView("chat");
          }
        }
      } catch {
        localStorage.removeItem("wechat-agent-chats");
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("wechat-agent-chats", JSON.stringify(chats));
  }, [chats]);

  useEffect(() => {
    if (localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true") return;

    let cancelled = false;
    async function detectCompletedOnboarding() {
      try {
        const result = await call<InitCheckResult>("check_local_init_status");
        if (!cancelled && result.queryReady) {
          completeOnboarding();
        }
      } catch {
        // Keep the normal onboarding flow if the local wx-cli check is not ready yet.
      }
    }

    void detectCompletedOnboarding();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view !== "onboarding" || step !== "permission") return;
    void refreshPermissionStatus();
  }, [view, step]);

  useEffect(() => {
    if (view !== "onboarding" || step !== "confirm") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        void refreshInitStatus();
      }
    }, 90);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [view, step]);

  async function startSetup() {
    setStep("setup");
    setBusy(true);
    setDiagnose(null);
    setSetupChecksState(setupChecks(null, "checking", "正在准备本机微信连接"));
    setSetupPhase("checking");
    setSetupLog("正在准备本机微信连接");
    try {
      let result = await call<DiagnoseResult>("diagnose_environment");
      await revealSetupChecks(result);
      setDiagnose(result);
      const missingTools = result.checks.some((item) => ["wx", "opencli"].includes(item.key) && !item.ok);

      if (missingTools) {
        setSetupPhase("installing");
        setSetupLog("缺少本机读取工具，正在尝试自动安装");
        setSetupChecksState((prev) =>
          prev.map((check) =>
            ["wx", "opencli"].includes(check.key)
              ? { ...check, status: "checking", detail: "正在自动安装" }
              : check,
          ),
        );
        await call("install_cli_tools");
        setSetupPhase("verifying");
        setSetupLog("正在重新验证本地依赖");
        setSetupChecksState((prev) =>
          prev.map((check) =>
            ["wx", "opencli"].includes(check.key)
              ? { ...check, status: "checking", detail: "正在安装后复查" }
              : check,
          ),
        );
        result = await call<DiagnoseResult>("diagnose_environment");
        await revealSetupChecks(result);
        setDiagnose(result);
      }

      const setupReady = setupEnvironmentReady(result);
      setSetupLog(setupReady ? "环境检查完成，下一步授权磁盘访问" : "仍有项目需要处理");
      setSetupPhase(setupReady ? "ready" : "needsAttention");
    } catch (error) {
      setSetupLog(errorMessage(error));
      setSetupPhase("error");
      setSetupChecksState((prev) =>
        prev.map((check) => (check.status === "checking" ? { ...check, status: "blocked" } : check)),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePermissionAction() {
    if (permissionStatus === "granted") {
      setInitStatus("checking");
      setInitDetail("正在读取本机配置，并尝试验证 1 条微信会话。");
      setInitProgress(createInitProgress({ config: "checking" }));
      setStep("confirm");
      return;
    }

    if (permissionStatus === "checking") {
      return;
    }

    if (!permissionOpened) {
      setPermissionOpened(true);
      try {
        await call("open_full_disk_access_settings");
      } catch {
        // The UI still lets the user continue because macOS settings can be opened manually.
      }
      return;
    }

    await refreshPermissionStatus();
  }

  async function refreshPermissionStatus() {
    setPermissionStatus("checking");
    setPermissionDetail("正在确认桌面端是否能读取微信数据目录");
    try {
      const result = await withMinimumDelay(call<DiagnoseResult>("diagnose_environment"));
      setDiagnose(result);
      const dataAccess = result.checks.find((item) => item.key === "wechatDataAccess");

      if (dataAccess?.ok) {
        setPermissionStatus("granted");
        setPermissionDetail(dataAccess.detail);
        return true;
      } else {
        setPermissionStatus("blocked");
        setPermissionDetail(dataAccess?.detail ?? "尚未检测到微信数据访问权限");
        return false;
      }
    } catch (error) {
      setPermissionStatus("error");
      setPermissionDetail(errorMessage(error));
      return false;
    }
  }

  async function refreshInitStatus() {
    setInitStatus("checking");
    setInitDetail("正在检查本机配置");
    setInitProgress(createInitProgress({ config: "checking" }));
    try {
      const result = await call<InitCheckResult>("check_local_init_status");
      return applyInitCheckResult(result);
    } catch (error) {
      setInitStatus("needsInit");
      setInitDetail(errorMessage(error) || "尚未完成初始化，需要执行一次本机初始化");
      setInitProgress(createInitProgress({ query: "blocked" }));
      return false;
    }
  }

  function applyInitCheckResult(result: InitCheckResult) {
    if (!result.configReady) {
      setInitStatus("needsInit");
      setInitDetail(result.detail || "尚未创建 ~/.wx-cli 本机配置，需要执行一次初始化");
      setInitProgress(createInitProgress({ query: "blocked" }));
      return false;
    }

    if (result.queryReady) {
      setInitStatus("ready");
      setInitDetail(result.detail || "已检测到可用的本机微信读取能力");
      setInitProgress(createInitProgress({ config: "ready", query: "ready", finish: "ready" }));
      localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
      return true;
    }

    setInitStatus("needsInit");
    setInitDetail(result.detail || "本机配置已存在，但还不能读取微信会话，需要重新初始化");
    setInitProgress(createInitProgress({ query: "blocked" }));
    return false;
  }

  async function revealSetupChecks(result: DiagnoseResult) {
    const nextChecks = setupChecks(result, "ready", setupLog);

    for (const nextCheck of nextChecks) {
      setSetupChecksState((prev) =>
        prev.map((check) =>
          check.key === nextCheck.key
            ? {
                ...check,
                detail: nextCheck.detail,
                status: "checking",
              }
            : check,
        ),
      );
      await sleep(SETUP_CHECKING_DELAY_MS);
      setSetupChecksState((prev) =>
        prev.map((check) =>
          check.key === nextCheck.key
            ? {
                ...check,
                detail: nextCheck.detail,
                status: nextCheck.status,
              }
            : check,
        ),
      );
      await sleep(SETUP_RESULT_DELAY_MS);
    }
  }

  async function confirmInit() {
    if (initStatus === "ready") {
      completeOnboarding();
      return;
    }

    if (initStatus === "checking" || initStatus === "initializing") {
      return;
    }

    if (initStatus === "waitingExternal") {
      setBusy(true);
      try {
        const ready = await refreshInitStatus();
        if (ready) {
          completeOnboarding();
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    setInitStatus("initializing");
    setInitDetail("正在打开 Terminal，按 wx-cli 推荐流程执行初始化。");
    setInitProgress(createInitProgress({ query: "checking" }));
    try {
      await call("run_wx_init");
      setInitStatus("waitingExternal");
      setInitDetail("已打开 Terminal。请在 Terminal 中完成 wx-cli 初始化，看到验证通过后回到这里重新检查。");
      setInitProgress(createInitProgress({ query: "blocked" }));
    } catch (error) {
      setInitStatus("error");
      setInitDetail(errorMessage(error));
      setInitProgress(createInitProgress({ query: "blocked" }));
    } finally {
      setBusy(false);
    }
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question) return;

    setInput("");
    const chatId = `chat_${Date.now()}`;
    const pendingId = `${chatId}_assistant_pending`;
    const newChat: AgentChat = {
      id: chatId,
      title: question.length > 18 ? `${question.slice(0, 18)}…` : question,
      updatedAt: "刚刚",
      messages: [
        { id: `${chatId}_user`, role: "user", content: question },
        {
          id: pendingId,
          role: "assistant",
          content: "",
          thinkingStep: "定位微信会话",
          pending: true,
          activities: [
            {
              id: `${pendingId}_status_initial`,
              kind: "status",
              label: "理解问题",
              detail: "准备选择本机微信工具",
              status: "running",
            },
          ],
        },
      ],
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(chatId);
    setView("chat");
    await answerQuestion(chatId, pendingId, question);
  }

  async function answerQuestion(chatId: string, messageId: string, question: string) {
    const streamId = `${chatId}:${messageId}:${Date.now()}`;
    setActiveStream({ streamId, chatId, messageId });
    let streamed = false;
    let unlistenDelta: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenTool: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;

    try {
      unlistenDelta = await listen<ChatDeltaPayload>("chat:delta", (event) => {
        if (event.payload.streamId === streamId) {
          if (!streamed) {
            replaceAssistant(chatId, messageId, "", []);
          }
          streamed = true;
          appendAssistantDelta(chatId, messageId, event.payload.delta);
        }
      });
      unlistenError = await listen<ChatErrorPayload>("chat:error", (event) => {
        if (event.payload.streamId === streamId) {
          appendAgentActivity(chatId, messageId, {
            id: `${streamId}:error:${Date.now()}`,
            kind: "status",
            label: "调用失败",
            detail: event.payload.message,
            status: "error",
          });
          replaceAssistant(chatId, messageId, event.payload.message, []);
        }
      });
      unlistenCancelled = await listen<ChatCancelledPayload>("chat:cancelled", (event) => {
        if (event.payload.streamId === streamId) {
          stopAssistant(chatId, messageId, event.payload.message);
        }
      });
      unlistenStatus = await listen<AgentStatusPayload>("agent:status", (event) => {
        if (event.payload.streamId === streamId) {
          setAssistantThinking(chatId, messageId, event.payload.message);
          appendAgentActivity(chatId, messageId, {
            id: `${streamId}:status:${Date.now()}`,
            kind: "status",
            label: event.payload.message,
            status: "running",
          });
        }
      });
      unlistenTool = await listen<AgentToolPayload>("agent:tool", (event) => {
        if (event.payload.streamId === streamId) {
          upsertToolActivity(chatId, messageId, event.payload);
        }
      });

      const response = await call<{ answer: string; citations: Citation[] }>("ask_agent_runtime", {
        request: { question },
        streamId,
      });
      if (!streamed && response.answer.trim()) {
        replaceAssistant(chatId, messageId, response.answer, response.citations);
        return;
      }
      finishAssistant(chatId, messageId, response.citations);
    } catch (error) {
      replaceAssistant(
        chatId,
        messageId,
        `已经收到问题，但 agent runtime、wx-cli 或模型调用还没有完成：${errorMessage(error)}\n\n你可以先检查 wx-cli 是否可用、Node.js 是否为 22+，以及是否设置了 AGENT_API_KEY。`,
        [],
      );
    } finally {
      unlistenDelta?.();
      unlistenError?.();
      unlistenCancelled?.();
      unlistenStatus?.();
      unlistenTool?.();
      setActiveStream((current) => (current?.streamId === streamId ? null : current));
    }
  }

  async function stopActiveStream() {
    if (!activeStream) return;
    const current = activeStream;
    stopAssistant(current.chatId, current.messageId, "已停止生成");
    setActiveStream(null);
    try {
      await call("cancel_agent_runtime", { streamId: current.streamId });
    } catch {
      // The runtime may have already finished between the click and the command.
    }
  }

  function appendAssistant(chatId: string, content: string, citations: Citation[]) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                {
                  id: `${chatId}_assistant_${Date.now()}`,
                  role: "assistant",
                  content,
                  citations,
                },
              ],
            }
          : chat,
      ),
    );
  }

  function appendAssistantDelta(chatId: string, messageId: string, delta: string) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content: `${message.content}${delta}`,
                      pending: false,
                      thinkingStep: undefined,
                    }
                  : message,
              ),
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  function replaceAssistant(chatId: string, messageId: string, content: string, citations: Citation[]) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content,
                      citations,
                      pending: false,
                      thinkingStep: undefined,
                    }
                  : message,
              ),
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  function finishAssistant(chatId: string, messageId: string, citations: Citation[]) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      citations,
                      pending: false,
                      thinkingStep: undefined,
                    }
                  : message,
              ),
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  function stopAssistant(chatId: string, messageId: string, fallbackContent: string) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content: message.content.trim() ? message.content : fallbackContent,
                      pending: false,
                      thinkingStep: undefined,
                      activities: [
                        ...(message.activities ?? []),
                        {
                          id: `${messageId}_stopped_${Date.now()}`,
                          kind: "status",
                          label: "已停止生成",
                          status: "done",
                        },
                      ],
                    }
                  : message,
              ),
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  function continueChat(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question || !activeChat) return;
    setInput("");
    const userMessageId = `m_${Date.now()}`;
    const pendingId = `${userMessageId}_assistant_pending`;
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === activeChat.id
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                { id: userMessageId, role: "user", content: question },
                {
                  id: pendingId,
                  role: "assistant",
                  content: "",
                  thinkingStep: "结合上下文继续分析",
                  pending: true,
                  activities: [
                    {
                      id: `${pendingId}_status_initial`,
                      kind: "status",
                      label: "继续分析",
                      detail: "读取当前问题并准备调用工具",
                      status: "running",
                    },
                  ],
                },
              ],
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
    void answerQuestion(activeChat.id, pendingId, `${activeChat.title} ${question}`);
  }

  function clearChat(chatId: string) {
    const nextChats = chats.filter((chat) => chat.id !== chatId);
    setChats(nextChats);

    if (activeChatId === chatId) {
      const nextActiveChat = nextChats[0];
      setActiveChatId(nextActiveChat?.id ?? "");
      setView(nextActiveChat ? "chat" : "home");
    }
  }

  function setAssistantThinking(chatId: string, messageId: string, thinkingStep: string) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content: "",
                      thinkingStep,
                      pending: true,
                    }
                  : message,
              ),
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  function appendAgentActivity(chatId: string, messageId: string, activity: AgentActivity) {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      activities: [...(message.activities ?? []), activity],
                    }
                  : message,
              ),
            }
          : chat,
      ),
    );
  }

  function upsertToolActivity(chatId: string, messageId: string, payload: AgentToolPayload) {
    const detail = payload.summary ?? formatToolInput(payload.input);
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) => {
                if (message.id !== messageId) return message;
                const activities = message.activities ?? [];
                const existingIndex = [...activities].reverse().findIndex((activity) => activity.tool === payload.tool);
                if (existingIndex === -1 || payload.status === "running") {
                  return {
                    ...message,
                    activities: [
                      ...activities,
                      {
                        id: `${messageId}:${payload.tool}:${Date.now()}`,
                        kind: "tool",
                        label: payload.label,
                        detail,
                        status: payload.status,
                        tool: payload.tool,
                      },
                    ],
                  };
                }

                const targetIndex = activities.length - 1 - existingIndex;
                return {
                  ...message,
                  activities: activities.map((activity, index) =>
                    index === targetIndex
                      ? {
                          ...activity,
                          detail,
                          status: payload.status,
                        }
                      : activity,
                  ),
                };
              }),
            }
          : chat,
      ),
    );
  }

  function handleOnboardingBack() {
    if (step === "setup") {
      setStep("welcome");
      return;
    }

    if (step === "permission") {
      setStep("setup");
      return;
    }

    if (step === "confirm") {
      setStep("permission");
    }
  }

  function completeOnboarding() {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setView("home");
  }

  if (view === "onboarding") {
    return (
      <Onboarding
        step={step}
        diagnose={diagnose}
        setupChecks={setupChecksState}
        setupPhase={setupPhase}
        setupLog={setupLog}
        permissionStatus={permissionStatus}
        permissionDetail={permissionDetail}
        initStatus={initStatus}
        initDetail={initDetail}
        initProgress={initProgress}
        busy={busy}
        permissionOpened={permissionOpened}
        onStart={startSetup}
        onBack={handleOnboardingBack}
        onSetupNext={() => {
          setPermissionStatus("checking");
          setPermissionDetail("正在确认桌面端是否能读取微信数据目录");
          setStep("permission");
        }}
        onPermission={handlePermissionAction}
        onConfirm={confirmInit}
        onReady={completeOnboarding}
      />
    );
  }

  if (view === "chat" && activeChat) {
    return (
      <ChatShell
        chats={chats}
        activeChatId={activeChat.id}
        onNew={() => {
          setActiveChatId("");
          setView("home");
        }}
        onOpen={(id) => {
          setActiveChatId(id);
          setView("chat");
        }}
        onClear={clearChat}
      >
        <ExistingChat
          chat={activeChat}
          input={input}
          setInput={setInput}
          onSubmit={continueChat}
          generating={activeStream?.chatId === activeChat.id}
          onStop={stopActiveStream}
          onClear={() => clearChat(activeChat.id)}
        />
      </ChatShell>
    );
  }

  return (
    <ChatShell
      chats={chats}
      activeChatId=""
      onNew={() => {
        setActiveChatId("");
        setView("home");
      }}
      onOpen={(id) => {
        setActiveChatId(id);
        setView("chat");
      }}
      onClear={clearChat}
    >
      <ChatHome input={input} setInput={setInput} onSubmit={submitQuestion} />
    </ChatShell>
  );
}

function Onboarding({
  step,
  diagnose,
  setupChecks,
  setupPhase,
  setupLog,
  permissionStatus,
  permissionDetail,
  initStatus,
  initDetail,
  initProgress,
  busy,
  permissionOpened,
  onStart,
  onBack,
  onSetupNext,
  onPermission,
  onConfirm,
  onReady,
}: {
  step: OnboardingStep;
  diagnose: DiagnoseResult | null;
  setupChecks: SetupCheck[];
  setupPhase: SetupPhase;
  setupLog: string;
  permissionStatus: PermissionStatus;
  permissionDetail: string;
  initStatus: InitStatus;
  initDetail: string;
  initProgress: InitProgressStep[];
  busy: boolean;
  permissionOpened: boolean;
  onStart: () => void;
  onBack: () => void;
  onSetupNext: () => void;
  onPermission: () => void;
  onConfirm: () => void;
  onReady: () => void;
}) {
  const config = onboardingCopy[step];
  const showBack = step === "setup" || step === "permission" || step === "confirm";

  return (
    <main className="onboarding-frame">
      <section className="onboarding-left">
        <Brand />
        <TrustPill />
        <MockPanel
          key={`mock-${step}`}
          step={step}
          setupChecks={setupChecks}
          setupPhase={setupPhase}
          setupLog={setupLog}
          permissionStatus={permissionStatus}
          initStatus={initStatus}
        />
        <div
          key={`copy-${step}`}
          className={`left-copy ${step === "confirm" || step === "ready" ? "left-copy-centered" : ""}`}
        >
          <h2>{config.leftTitle}</h2>
          <p>{config.leftDescription}</p>
        </div>
        {showBack && (
          <button className="back-pill" type="button" onClick={onBack}>
            <ArrowLeft size={14} />
            返回
          </button>
        )}
      </section>
      <section className="onboarding-right">
        <div className="step-top">
          <strong>{config.kicker}</strong>
          <span className={`step-pill ${step === "ready" ? "ready" : ""}`}>{config.stepLabel}</span>
        </div>
        <div key={`body-${step}`} className={`step-body ${step === "setup" ? "setup-body" : ""}`}>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
          <StepContent
            step={step}
            diagnose={diagnose}
            setupChecks={setupChecks}
            setupPhase={setupPhase}
            setupLog={setupLog}
            permissionOpened={permissionOpened}
            permissionStatus={permissionStatus}
            permissionDetail={permissionDetail}
            initStatus={initStatus}
            initDetail={initDetail}
            initProgress={initProgress}
            busy={busy}
            onConfirm={onConfirm}
          />
        </div>
        <button
          className="primary-cta bottom-right"
          type="button"
          onClick={
            step === "welcome"
              ? onStart
              : step === "setup"
                ? onSetupNext
                : step === "permission"
                  ? onPermission
                  : step === "confirm"
                    ? onConfirm
                    : onReady
          }
          disabled={
            busy ||
            (step === "permission" && permissionStatus === "checking") ||
            (step === "confirm" && initStatus !== "ready")
          }
        >
          {busy ||
          (step === "permission" && permissionStatus === "checking") ||
          (step === "confirm" && initStatus === "checking") ? (
            <LoaderCircle className="spin" size={16} />
          ) : null}
          {step === "welcome"
            ? "开始自动设置"
            : step === "setup"
              ? busy
                ? "正在自动设置"
                : "下一步：授权磁盘访问"
              : step === "permission"
                ? permissionStatus === "checking"
                  ? "正在检查权限"
                  : permissionStatus === "granted"
                    ? "下一步"
                    : permissionOpened
                      ? "我已授权，重新检查"
                      : "打开系统设置"
                : step === "confirm"
                  ? initStatus === "checking"
                    ? "正在检查"
                    : initStatus === "ready"
                      ? "下一步"
                      : initStatus === "initializing"
                        ? "正在初始化"
                        : "等待初始化"
                  : "进入新对话"}
          {step === "permission" && !permissionOpened && permissionStatus !== "granted" ? (
            <ArrowUpRight size={16} />
          ) : (
            <ArrowRight size={16} />
          )}
        </button>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <div className="brand">
      <MessageCircle size={22} />
      <span>微信助手</span>
    </div>
  );
}

function TrustPill() {
  return (
    <div className="trust-pill">
      <HardDrive size={14} />
      本机数据 · 不上传
    </div>
  );
}

function MockPanel({
  step,
  setupChecks,
  setupPhase,
  setupLog,
  permissionStatus,
  initStatus,
}: {
  step: OnboardingStep;
  setupChecks: SetupCheck[];
  setupPhase: SetupPhase;
  setupLog: string;
  permissionStatus: PermissionStatus;
  initStatus: InitStatus;
}) {
  if (step === "setup") {
    const readyCount = setupChecks.filter((check) => check.status === "ready").length;
    const blockedCount = setupChecks.filter((check) => check.status === "blocked").length;
    const activeCheck = setupChecks.find((check) => check.status === "checking");
    const checkedCount = readyCount + blockedCount;
    const progressUnits = checkedCount + (activeCheck ? 0.55 : 0);
    const progress = `${Math.max(8, Math.round((progressUnits / setupChecks.length) * 100))}%`;
    const logLines = setupLogLines(setupChecks, setupPhase).slice(-3);
    return (
      <div className="mock-panel mock-cli compact">
        <div className="mock-line muted">&gt; 自动执行</div>
        <div className="mock-log-window">
          <div className="mock-log-track" key={logLines.join("|")}>
            {logLines.map((line, index) => (
              <div
                className={`terminal-log-line ${line.tone ?? "default"} ${index === logLines.length - 1 ? "current" : ""}`}
                key={line.text}
                style={{ animationDelay: `${index * 45}ms` }}
              >
                <span className="terminal-prefix">{line.prefix}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mock-count-line">{`已检查 ${checkedCount}/${setupChecks.length}`}</div>
        <div className="progress-track">
          <span style={{ width: progress }} />
        </div>
      </div>
    );
  }

  if (step === "permission") {
    const permissionReady = permissionStatus === "granted";
    const permissionChecking = permissionStatus === "checking";
    return (
      <div className="mock-panel">
        <div className="mock-heading">
          <ShieldCheck size={18} />
          macOS 权限
        </div>
        <div className={`permission-card ${permissionReady ? "granted" : ""}`}>
          <strong>完全磁盘访问</strong>
          <span>{permissionReady ? "桌面端已可读取微信数据目录" : "需要用户在系统设置中手动开启"}</span>
        </div>
        <div className={`soft-row ${permissionReady ? "granted" : permissionChecking ? "checking" : ""}`}>
          {permissionChecking ? <LoaderCircle className="spin" size={17} /> : permissionReady ? <CircleCheck size={17} /> : <Settings size={17} />}
          {permissionChecking ? "正在检查授权状态" : permissionReady ? "授权已确认" : "打开系统设置"}
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    const initReady = initStatus === "ready";
    const initChecking = initStatus === "checking" || initStatus === "initializing";
    return (
      <div className="mock-panel mock-cli dark">
        <div className="mock-line muted">local init</div>
        <div>{initChecking ? "$ wx sessions -n 1" : initReady ? "$ 本机读取能力已可用" : "$ wx init"}</div>
        <div>{initReady ? "$ 跳过重复初始化" : "$ 检查本机读取状态"}</div>
        <div className={initReady ? "success-line" : "mock-line muted"}>
          {initChecking ? "checking local query ability" : initReady ? "ready for local query" : "waiting for initialization"}
        </div>
      </div>
    );
  }

  if (step === "ready") {
    return (
      <div className="mock-panel success-panel">
        <div className="success-mark">
          <Check size={30} />
        </div>
        <strong>微信数据已连接</strong>
        <span>可以开始提问</span>
      </div>
    );
  }

  return (
    <div className="mock-panel">
      <div className="mock-heading">
        <span className="green-dot" />
        本机微信数据
      </div>
      <div className="bubble neutral">
        <Users size={17} />
        产品讨论群
      </div>
      <div className="bubble green">
        <SearchCheck size={17} />
        检索上下文与引用
      </div>
      <div className="bubble black">
        <Sparkles size={17} />
        生成回答
      </div>
    </div>
  );
}

function StepContent({
  step,
  diagnose,
  setupChecks,
  setupPhase,
  setupLog,
  permissionOpened,
  permissionStatus,
  permissionDetail,
  initStatus,
  initDetail,
  initProgress,
  busy,
  onConfirm,
}: {
  step: OnboardingStep;
  diagnose: DiagnoseResult | null;
  setupChecks: SetupCheck[];
  setupPhase: SetupPhase;
  setupLog: string;
  permissionOpened: boolean;
  permissionStatus: PermissionStatus;
  permissionDetail: string;
  initStatus: InitStatus;
  initDetail: string;
  initProgress: InitProgressStep[];
  busy: boolean;
  onConfirm: () => void;
}) {
  if (step === "welcome") {
    return (
      <div className="card-stack">
        <InfoCard icon={<MessageCircle />} title="读取本机微信记录" text="只读取已同步到 Mac 的本地数据" tone="green" />
        <InfoCard icon={<Terminal />} title="准备本机读取工具" text="桌面端一键处理检查和安装" tone="blue" />
        <InfoCard icon={<Sparkles />} title="完成后直接开始提问" text="用聊天方式查询群聊、联系人和引用" tone="purple" />
      </div>
    );
  }

  if (step === "setup") {
    return (
      <div className="card-stack setup-grid">
        {setupChecks.map((check) => (
          <StatusCard key={check.key} status={check.status} title={check.label} text={check.detail} />
        ))}
      </div>
    );
  }

  if (step === "permission") {
    const content = permissionStateCopy(permissionStatus, permissionOpened, permissionDetail);
    return (
      <div className={`warning-card permission-state ${permissionStatus}`}>
        {permissionStatus === "checking" ? (
          <LoaderCircle className="spin" size={20} />
        ) : permissionStatus === "granted" ? (
          <CircleCheck size={20} />
        ) : (
          <TriangleAlert size={20} />
        )}
        <div>
          <strong>{content.title}</strong>
          <span>{content.text}</span>
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    const content = initStateCopy(initStatus, initDetail);
    return (
      <div className={`warning-card init-state ${initStatus}`}>
        <div className="init-state-header">
          <strong>
            {content.title}
            {(initStatus === "idle" || initStatus === "checking") && <AnimatedEllipsis />}
          </strong>
          <InitStatusPill status={initStatus} />
        </div>
        <span>{content.text}</span>
        {content.log ? (
          <details className="init-log-details">
            <summary>查看最近日志</summary>
            <pre>{content.log}</pre>
          </details>
        ) : null}
        {initStatus !== "checking" && initStatus !== "ready" && <InitProgressList steps={initProgress} />}
        {(initStatus === "needsInit" || initStatus === "waitingExternal" || initStatus === "error") && (
          <button className="inline-init-button" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Terminal size={15} />}
            {initStatus === "waitingExternal" ? "重新检查" : "开始初始化"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card-stack">
      <PromptCard icon={<MessagesSquare />} text="总结这个产品群最近 7 天在讨论什么" />
      <PromptCard icon={<UserSearch />} text="帮我找某个人最近提到的关键事项" />
    </div>
  );
}

function InfoCard({ icon, title, text, tone }: { icon: ReactNode; title: string; text: string; tone: string }) {
  return (
    <div className="info-card">
      <div className={`icon-cell ${tone}`}>{icon}</div>
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function StatusCard({ status, title, text }: { status: SetupCheckStatus; title: string; text: string }) {
  const icon = status === "ready" ? <CircleCheck /> : status === "checking" ? <LoaderCircle className="spin" /> : <Download />;
  const statusLabel =
    status === "ready" ? "已就绪" : status === "checking" ? "检查中" : status === "blocked" ? "需要处理" : "等待检查";
  return (
    <div className={`info-card setup-check ${status}`}>
      <div className={`status-icon ${status}`}>{icon}</div>
      <div>
        <strong>
          {title}
          <em>{statusLabel}</em>
        </strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function AnimatedEllipsis() {
  return (
    <span className="animated-ellipsis" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function InitStatusPill({ status }: { status: InitStatus }) {
  const label =
    status === "checking"
      ? "检查中"
      : status === "ready"
        ? "已完成"
      : status === "initializing"
        ? "执行中"
        : status === "waitingExternal"
          ? "等待完成"
        : "需要处理";

  return <em className={`init-status-pill ${status}`}>{label}</em>;
}

function InitProgressList({ steps }: { steps: InitProgressStep[] }) {
  const activeStep = activeInitProgressStep(steps);
  if (!activeStep) return null;

  const labels: Record<InitProgressStatus, string> = {
    pending: "等待",
    checking: "检查中",
    ready: "完成",
    blocked: "需要处理",
  };

  return (
    <div className="init-progress-list">
      <div className={`init-progress-row ${activeStep.status}`} key={activeStep.key}>
        <div>
          <strong>
            {activeStep.label}
            <em>{labels[activeStep.status]}</em>
          </strong>
          <span>{activeStep.detail}</span>
        </div>
      </div>
    </div>
  );
}

function PromptCard({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="prompt-card">
      {icon}
      <strong>{text}</strong>
    </div>
  );
}

function ChatShell({
  chats,
  activeChatId,
  onNew,
  onOpen,
  onClear,
  children,
}: {
  chats: AgentChat[];
  activeChatId: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onClear: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <main className="chat-frame">
      <aside className="chat-sidebar">
        <div className="sidebar-brand">
          <MessageCircle size={20} />
          微信助手
        </div>
        <button className="new-chat" type="button" onClick={onNew}>
          <SquarePen size={17} />
          新对话
        </button>
        <div className="history-title">对话</div>
        <div className="history-list">
          {chats.length === 0 ? (
            <div className="history-empty">暂无对话</div>
          ) : (
            chats.map((chat) => (
              <div className={`history-row ${chat.id === activeChatId ? "active" : ""}`} key={chat.id}>
                <button className="history-item" type="button" onClick={() => onOpen(chat.id)}>
                  <span>{chat.title}</span>
                  <small>{chat.updatedAt}</small>
                </button>
                <button
                  className="history-clear"
                  type="button"
                  aria-label={`清除 ${chat.title}`}
                  onClick={() => onClear(chat.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>
      <section className="chat-main">{children}</section>
    </main>
  );
}

function ChatHome({
  input,
  setInput,
  onSubmit,
}: {
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="home-stage">
      <h1>我们该做什么？</h1>
      <ChatComposer
        placeholder="问问微信历史、群聊上下文或某段聊天记录…"
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function ExistingChat({
  chat,
  input,
  setInput,
  onSubmit,
  generating,
  onStop,
  onClear,
}: {
  chat: AgentChat;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  generating: boolean;
  onStop: () => void;
  onClear: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = chat.messages
    .map((message) => `${message.id}:${message.content.length}:${message.pending ? "1" : "0"}:${message.activities?.length ?? 0}`)
    .join("|");

  useEffect(() => {
    window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }, [scrollKey]);

  return (
    <div className="conversation">
      <header className="conversation-header">
        <strong>{chat.title}</strong>
        <div className="conversation-menu">
          <button
            className="conversation-menu-trigger"
            type="button"
            aria-label="打开对话菜单"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={20} />
          </button>
          {menuOpen && (
            <div className="conversation-dropdown" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onClear();
                }}
              >
                <Trash2 size={15} />
                Clear chat
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="message-column">
        {chat.messages.map((message) => (
          <article className={`message ${message.role} ${message.pending ? "pending" : ""}`} key={message.id}>
            {message.pending && message.thinkingStep ? (
              <ThinkingCard step={message.thinkingStep} activities={message.activities ?? []} />
            ) : message.role === "assistant" ? (
              <MarkdownContent content={message.content} />
            ) : (
              <p>{message.content}</p>
            )}
          </article>
        ))}
        <div className="message-scroll-anchor" ref={bottomRef} />
      </div>
      <div className="conversation-composer">
        <ChatComposer
          placeholder="要求后续变更"
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          compact
          generating={generating}
          onStop={onStop}
        />
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ThinkingCard({ step, activities }: { step: string; activities: AgentActivity[] }) {
  return (
    <div className="thinking-card" aria-live="polite">
      <div className="thinking-card-header">
        <span className="thinking-pulse">
          <i />
          <i />
          <i />
        </span>
        <strong>{step}</strong>
      </div>
      <AgentActivityList activities={activities} />
    </div>
  );
}

function AgentActivityList({ activities, compact = false }: { activities: AgentActivity[]; compact?: boolean }) {
  if (activities.length === 0) return null;
  const visible = activities.slice(-5);
  return (
    <div className={`agent-activity-list ${compact ? "compact" : ""}`}>
      {visible.map((activity) => (
        <div className={`agent-activity-row ${activity.status}`} key={activity.id}>
          <div className="agent-activity-icon">
            {activity.kind === "tool" ? (
              activity.status === "running" ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Wrench size={13} />
              )
            ) : activity.status === "error" ? (
              <TriangleAlert size={13} />
            ) : activity.status === "done" ? (
              <Check size={13} />
            ) : (
              <span />
            )}
          </div>
          <div>
            <strong>{activity.label}</strong>
            {activity.detail ? <span>{activity.detail}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatComposer({
  placeholder,
  input,
  setInput,
  onSubmit,
  generating = false,
  onStop,
  compact = false,
}: {
  placeholder: string;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  generating?: boolean;
  onStop?: () => void;
  compact?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 58), 168)}px`;
  }, [input]);

  return (
    <form
      className={`composer ${compact ? "compact" : ""} ${input.trim() ? "has-input" : ""} ${generating ? "generating" : ""}`}
      onSubmit={(event) => {
        if (generating) {
          event.preventDefault();
          onStop?.();
          return;
        }
        onSubmit(event);
      }}
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        placeholder={placeholder}
        rows={2}
      />
      <div className="composer-actions" aria-hidden="false">
        <button type="submit" aria-label={generating ? "停止生成" : "发送"}>
          {generating ? <Square size={16} fill="currentColor" /> : <ArrowUp size={20} />}
        </button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function formatToolInput(input: Record<string, unknown> | undefined) {
  if (!input) return undefined;
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${toolInputLabel(key)}：${String(value)}`);
  return entries.length > 0 ? entries.join(" · ") : undefined;
}

function toolInputLabel(key: string) {
  const labels: Record<string, string> = {
    session: "会话",
    since: "起始",
    limit: "数量",
    keyword: "关键词",
  };
  return labels[key] ?? key;
}

function setupEnvironmentReady(diagnose: DiagnoseResult) {
  const checkByKey = new Map(diagnose.checks.map((check) => [check.key, check]));
  return SETUP_DEPENDENCY_KEYS.every((key) => checkByKey.get(key)?.ok);
}

function createInitProgress(statuses: Partial<Record<InitProgressStep["key"], InitProgressStatus>> = {}): InitProgressStep[] {
  return [
    {
      key: "config",
      label: "检查是否需要初始化",
      detail: "确认本机配置和读取状态",
      status: statuses.config ?? "pending",
    },
    {
      key: "query",
      label: "执行本机初始化",
      detail: "会打开 Terminal 执行 wx-cli 推荐流程",
      status: statuses.query ?? "pending",
    },
    {
      key: "finish",
      label: "验证读取能力",
      detail: "读取 1 条微信会话",
      status: statuses.finish ?? "pending",
    },
  ];
}

function activeInitProgressStep(steps: InitProgressStep[]) {
  return (
    steps.find((step) => step.status === "checking") ??
    steps.find((step) => step.status === "blocked") ??
    null
  );
}

function setupChecks(diagnose: DiagnoseResult | null, phase: SetupPhase, setupLog: string): SetupCheck[] {
  const labels: Record<string, string> = {
    node: "准备运行环境",
    npm: "准备安装能力",
    wechat: "找到 Mac 微信",
    wx: "准备微信读取能力",
    opencli: "准备 agent 调用入口",
  };
  const details: Record<string, string> = {
    node: "用于在本机运行微信助手",
    npm: "用于自动准备缺少的组件",
    wechat: "确认这台 Mac 已安装微信",
    wx: "让 App 能读取本机微信记录",
    opencli: "让本机工具更适合 agent 调用",
  };

  if (!diagnose) {
    return SETUP_DEPENDENCY_KEYS.map((key, index) => ({
      key,
      label: labels[key],
      detail: index === 0 ? setupLog : details[key],
      status: phase === "idle" ? "pending" : index === 0 ? "checking" : "pending",
    }));
  }

  const checkByKey = new Map(diagnose.checks.map((check) => [check.key, check]));
  const firstBlockedIndex = SETUP_DEPENDENCY_KEYS.findIndex((key) => checkByKey.get(key)?.ok === false);
  const activeIndex = phase === "checking" || phase === "verifying" ? firstBlockedIndex : -1;

  return SETUP_DEPENDENCY_KEYS.map((key, index) => {
    const check = checkByKey.get(key);
    let status: SetupCheckStatus = check?.ok ? "ready" : "blocked";

    if (!check) {
      status = "pending";
    } else if (phase === "installing" && ["wx", "opencli"].includes(key) && !check.ok) {
      status = "checking";
    } else if (activeIndex === index && !check.ok) {
      status = "checking";
    }

    return {
      key,
      label: labels[key],
      detail: setupCheckDetail(key, check, details[key]),
      status,
    };
  });
}

function setupCheckDetail(key: string, check: CheckItem | undefined, fallback: string) {
  if (!check) return fallback;
  if (check.ok) {
    if (key === "wechat") return "已找到 Mac 微信";
    return "已准备好";
  }
  return fallback;
}

function setupLogLines(checks: SetupCheck[], phase: SetupPhase) {
  const lines: Array<{ text: string; prefix: string; tone?: "default" | "muted" | "success" | "warning" }> = [];

  for (const check of checks) {
    if (check.status === "ready") {
      lines.push({ prefix: "ok", text: `${check.label}检查完成`, tone: "success" });
    } else if (check.status === "blocked") {
      lines.push({ prefix: "!", text: `${check.label}需要处理`, tone: "warning" });
    } else if (check.status === "checking") {
      lines.push({ prefix: "run", text: `正在检查 ${check.label}` });
      if (check.detail) {
        lines.push({ prefix: "info", text: check.detail, tone: "muted" });
      }
    }
  }

  if (phase === "ready") {
    lines.push({ prefix: "ok", text: "所有检查已完成", tone: "success" });
  } else if (phase === "needsAttention" || phase === "error") {
    lines.push({ prefix: "!", text: "还有项目需要处理", tone: "warning" });
  }

  return lines.length > 0 ? lines : [{ prefix: "$", text: "准备开始检查" }];
}

function permissionStateCopy(status: PermissionStatus, permissionOpened: boolean, detail: string) {
  if (status === "checking") {
    return {
      title: "正在检查完全磁盘访问",
      text: "正在确认微信助手是否能读取本机微信数据目录。",
    };
  }

  if (status === "granted") {
    return {
      title: "完全磁盘访问已确认",
      text: "已检测到可读取的微信数据目录，可以进入下一步初始化。",
    };
  }

  if (status === "error") {
    return {
      title: "权限检查失败",
      text: detail,
    };
  }

  return {
    title: permissionOpened ? "尚未检测到完整授权" : "尚未授予完全磁盘访问",
    text: permissionOpened
      ? "完成授权后点击右下角重新检查；如仍未通过，请重启微信助手。"
      : "微信数据路径当前不可读取，请先打开系统设置授权。",
  };
}

function initStateCopy(status: InitStatus, detail: string) {
  const { text: cleanedDetail, log } = splitInitDetail(detail);

  if (status === "checking") {
    return {
      title: "正在判断是否需要初始化",
      text: "正在读取本机配置，并尝试验证 1 条微信会话。",
    };
  }

  if (status === "ready") {
    return {
      title: "初始化已完成",
      text: "本机微信读取能力已经可用，可以直接进入下一步。",
    };
  }

  if (status === "initializing") {
    return {
      title: "正在执行初始化",
      text: "正在打开 Terminal，准备执行 wx-cli 推荐初始化流程。",
    };
  }

  if (status === "waitingExternal") {
    return {
      title: "等待 Terminal 初始化完成",
      text: cleanedDetail || "请在 Terminal 中完成初始化，然后回到这里重新检查。",
      log,
    };
  }

  if (status === "error") {
    return {
      title: "初始化失败",
      text: cleanedDetail,
      log,
    };
  }

  return {
    title: "需要初始化",
    text: cleanedDetail || "尚未检测到可用的本机微信读取能力，需要执行一次初始化。",
    log,
  };
}

function splitInitDetail(detail: string) {
  const marker = "[[INIT_LOG]]";
  const index = detail.indexOf(marker);
  if (index === -1) {
    return { text: detail, log: "" };
  }

  return {
    text: detail.slice(0, index).trim(),
    log: detail.slice(index + marker.length).trim(),
  };
}

function resolveQuestionSession(question: string, sessions: SessionSummary[]) {
  const usable = sessions.filter((session) => isUsableSessionTitle(session.title));
  const normalizedQuestion = normalizeForSessionMatch(question);

  const directMatch = usable.find((session) => {
    const normalizedTitle = normalizeForSessionMatch(session.title);
    return (
      normalizedTitle.length >= 2 &&
      (normalizedQuestion.includes(normalizedTitle) || normalizedTitle.includes(normalizedQuestion))
    );
  });

  if (directMatch) {
    return { session: directMatch, options: usable.slice(0, 5) };
  }

  if (usable.length === 1) {
    return { session: usable[0], options: usable };
  }

  return { session: undefined, options: usable.slice(0, 5) };
}

function isUsableSessionTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return Boolean(
    normalized &&
      !["未命名会话", "unknown", "undefined", "null"].includes(normalized) &&
      !normalized.startsWith("{"),
  );
}

function normalizeForSessionMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s"'“”‘’`.,，。！？!?、:：;；()[\]{}<>《》~～_\-]/g, "");
}

function sessionClarificationMessage(options: SessionSummary[]) {
  if (options.length === 0) {
    return "我还不能确定要检索哪个微信会话，而且当前没有从本机工具里读到可用会话名。请先确认 wx sessions 能列出联系人或群聊，然后在问题里写出明确的群名或联系人名。";
  }

  const optionLines = options.map((session) => `- ${session.title}`).join("\n");
  return `我还不能确定要检索哪个微信会话。请在问题里写出明确的群名或联系人名，例如“某个群最近在聊什么？”\n\n当前能看到的会话：\n${optionLines}`;
}

const onboardingCopy: Record<
  OnboardingStep,
  {
    kicker: string;
    stepLabel: string;
    title: string;
    description: string;
    leftTitle: string;
    leftDescription: string;
  }
> = {
  welcome: {
    kicker: "欢迎",
    stepLabel: "Step 1 / 5",
    title: "先连接你的本机微信",
    description: "微信助手会自动检查环境、安装 wx-cli，并在需要你确认时停下来。",
    leftTitle: "把微信历史变成可以提问的上下文",
    leftDescription: "桌面端负责本地工具、授权和初始化，数据默认留在你的 Mac 上。",
  },
  setup: {
    kicker: "自动设置",
    stepLabel: "Step 2 / 5",
    title: "正在自动检查并安装",
    description: "桌面端正在处理本地依赖和配置。这个过程可以一键完成，不需要用户打开终端。",
    leftTitle: "安装和检查应该由 App 自动完成",
    leftDescription: "用户不需要复制命令。只有系统权限和敏感初始化需要明确确认。",
  },
  permission: {
    kicker: "需要授权",
    stepLabel: "Step 3 / 5",
    title: "允许读取本机微信数据",
    description: "macOS 需要你手动授予完全磁盘访问。授权后回到这里，桌面端会继续验证；如果仍未通过，请重启微信助手。",
    leftTitle: "权限请求要明确、可信、可返回",
    leftDescription: "这里不能静默处理，所以要告诉用户为什么需要权限，以及授权后会继续检查。",
  },
  confirm: {
    kicker: "确认初始化",
    stepLabel: "Step 4 / 5",
    title: "初始化微信读取能力",
    description: "下一步会在本机执行初始化命令，可能触发一次系统密码确认。",
    leftTitle: "敏感步骤需要用户确认",
    leftDescription: "初始化命令由桌面端执行，但在动到本地微信读取能力前要让用户知道发生了什么。",
  },
  ready: {
    kicker: "完成",
    stepLabel: "Ready",
    title: "微信数据已连接",
    description: "现在可以像 ChatGPT 一样提问你的本机微信历史，回答会带上可核对的引用。",
    leftTitle: "完成后直接进入聊天体验",
    leftDescription: "不再展示复杂设置，给用户几个可点击的问题建议，然后进入新对话。",
  },
};

export default App;

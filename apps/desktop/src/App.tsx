import { invoke } from "@tauri-apps/api/core";
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
  SearchCheck,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  UserSearch,
  Users,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";

type OnboardingStep = "welcome" | "setup" | "permission" | "confirm" | "ready";
type View = "onboarding" | "home" | "chat";

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

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

type AgentChat = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const seedChats: AgentChat[] = [
  {
    id: "seed_product",
    title: "产品讨论群摘要",
    updatedAt: "1 天",
    messages: [
      {
        id: "m1",
        role: "assistant",
        content:
          "这条链路通了：桌面端负责低延迟交互和工具决策，本地执行器负责真正跑 opencli wx，两边靠结构化参数和输出衔接。\n\n如果要做原型，优先从 Tauri + 本地 CLI wrapper 开始，先把权限、初始化、检索和引用跑顺。",
        citations: [
          {
            label: "本地导出批次",
            source: "/tmp/wechat-agent-kit/exports/product-demo.json",
          },
        ],
      },
      {
        id: "m2",
        role: "user",
        content: "明白了～",
      },
    ],
  },
  {
    id: "seed_cli",
    title: "本地工具调用链解释",
    updatedAt: "昨天",
    messages: [],
  },
  {
    id: "seed_visit",
    title: "来上海时间确认",
    updatedAt: "3 天",
    messages: [],
  },
];

const fallbackSessions: SessionSummary[] = [
  {
    id: "demo-product",
    title: "产品讨论群",
    subtitle: "Demo fallback",
  },
];

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function App() {
  const [view, setView] = useState<View>("onboarding");
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const [setupLog, setSetupLog] = useState("准备检查本地环境");
  const [busy, setBusy] = useState(false);
  const [permissionOpened, setPermissionOpened] = useState(false);
  const [chats, setChats] = useState<AgentChat[]>(seedChats);
  const [activeChatId, setActiveChatId] = useState("seed_product");
  const [input, setInput] = useState("");

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? chats[0],
    [activeChatId, chats],
  );

  useEffect(() => {
    const stored = localStorage.getItem("wechat-agent-chats");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as AgentChat[];
        if (parsed.length > 0) {
          setChats(parsed);
          setActiveChatId(parsed[0].id);
        }
      } catch {
        localStorage.removeItem("wechat-agent-chats");
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("wechat-agent-chats", JSON.stringify(chats));
  }, [chats]);

  async function startSetup() {
    setStep("setup");
    setBusy(true);
    setSetupLog("正在检查 Mac 微信、Node.js、wx-cli 和 opencli");
    try {
      let result = await call<DiagnoseResult>("diagnose_environment");
      setDiagnose(result);
      const missingTools = result.checks.some(
        (item) => ["wx", "opencli"].includes(item.key) && !item.ok,
      );

      if (missingTools) {
        setSetupLog("缺少 wx-cli / opencli，正在尝试自动安装");
        await call("install_cli_tools");
        result = await call<DiagnoseResult>("diagnose_environment");
        setDiagnose(result);
      }

      setSetupLog(result.ok ? "环境检查完成" : "仍有项目需要授权或确认");
      setStep("permission");
    } catch (error) {
      setSetupLog(errorMessage(error));
      setStep("permission");
    } finally {
      setBusy(false);
    }
  }

  async function handlePermissionAction() {
    if (!permissionOpened) {
      setPermissionOpened(true);
      try {
        await call("open_full_disk_access_settings");
      } catch {
        // The UI still lets the user continue because macOS settings can be opened manually.
      }
      return;
    }

    setBusy(true);
    setSetupLog("正在重新检查微信数据访问权限");
    try {
      const result = await call<DiagnoseResult>("diagnose_environment");
      setDiagnose(result);
      const dataAccess = result.checks.find((item) => item.key === "wechatDataAccess");

      if (dataAccess?.ok) {
        setSetupLog("微信数据访问权限已确认");
        setStep("confirm");
      } else {
        setSetupLog(dataAccess?.detail ?? "尚未检测到微信数据访问权限");
      }
    } catch (error) {
      setSetupLog(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmInit() {
    setBusy(true);
    try {
      await call("run_wx_init");
      setStep("ready");
    } catch (error) {
      setSetupLog(errorMessage(error));
      setStep("ready");
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
    const newChat: AgentChat = {
      id: chatId,
      title: question.length > 18 ? `${question.slice(0, 18)}…` : question,
      updatedAt: "刚刚",
      messages: [{ id: `${chatId}_user`, role: "user", content: question }],
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(chatId);
    setView("chat");

    try {
      const sessions = await call<SessionSummary[]>("list_sessions").catch(() => fallbackSessions);
      const resolution = resolveQuestionSession(question, sessions);

      if (!resolution.session) {
        appendAssistant(chatId, sessionClarificationMessage(resolution.options), []);
        return;
      }

      const exported = await call<ExportResult>("export_history", {
        session: resolution.session.title,
        since: "2026-04-13",
        limit: 5000,
      });
      const response = await call<{ answer: string; citations: Citation[] }>("ask_qwen", {
        request: { question, contextFile: exported.file },
      });

      appendAssistant(chatId, response.answer, response.citations);
    } catch (error) {
      appendAssistant(
        chatId,
        `已经收到问题，但本机 CLI 或 Qwen 调用还没有完成：${errorMessage(error)}\n\n你可以先检查 opencli / wx 是否可用，以及是否设置了 QWEN_API_KEY。`,
        [],
      );
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

  function continueChat(event: FormEvent) {
    event.preventDefault();
    const question = input.trim();
    if (!question || !activeChat) return;
    setInput("");
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === activeChat.id
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                { id: `m_${Date.now()}`, role: "user", content: question },
                {
                  id: `m_${Date.now()}_a`,
                  role: "assistant",
                  content:
                    "这条追问会沿用当前对话上下文。下一步实现会把上一轮导出批次作为 contextFile 继续传给 Qwen。",
                  citations: chat.messages.flatMap((message) => message.citations ?? []).slice(0, 1),
                },
              ],
              updatedAt: "刚刚",
            }
          : chat,
      ),
    );
  }

  if (view === "onboarding") {
    return (
      <Onboarding
        step={step}
        diagnose={diagnose}
        setupLog={setupLog}
        busy={busy}
        permissionOpened={permissionOpened}
        onStart={startSetup}
        onBack={() => setStep(step === "confirm" ? "permission" : "setup")}
        onPermission={handlePermissionAction}
        onConfirm={confirmInit}
        onReady={() => setView("home")}
      />
    );
  }

  if (view === "chat" && activeChat) {
    return (
      <ChatShell
        chats={chats}
        activeChatId={activeChat.id}
        onNew={() => setView("home")}
        onOpen={(id) => {
          setActiveChatId(id);
          setView("chat");
        }}
      >
        <ExistingChat chat={activeChat} input={input} setInput={setInput} onSubmit={continueChat} />
      </ChatShell>
    );
  }

  return (
    <ChatShell
      chats={chats}
      activeChatId={activeChatId}
      onNew={() => setView("home")}
      onOpen={(id) => {
        setActiveChatId(id);
        setView("chat");
      }}
    >
      <ChatHome input={input} setInput={setInput} onSubmit={submitQuestion} />
    </ChatShell>
  );
}

function Onboarding({
  step,
  diagnose,
  setupLog,
  busy,
  permissionOpened,
  onStart,
  onBack,
  onPermission,
  onConfirm,
  onReady,
}: {
  step: OnboardingStep;
  diagnose: DiagnoseResult | null;
  setupLog: string;
  busy: boolean;
  permissionOpened: boolean;
  onStart: () => void;
  onBack: () => void;
  onPermission: () => void;
  onConfirm: () => void;
  onReady: () => void;
}) {
  const config = onboardingCopy[step];
  const showBack = step === "permission" || step === "confirm";

  return (
    <main className="onboarding-frame">
      <section className="onboarding-left">
        <Brand />
        <TrustPill />
        <MockPanel step={step} diagnose={diagnose} setupLog={setupLog} />
        <div className={`left-copy ${step === "confirm" || step === "ready" ? "left-copy-centered" : ""}`}>
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
        <div className="step-body">
          <h1>{config.title}</h1>
          <p>{config.description}</p>
          <StepContent step={step} diagnose={diagnose} setupLog={setupLog} permissionOpened={permissionOpened} />
        </div>
        <button
          className="primary-cta bottom-right"
          type="button"
          onClick={
            step === "welcome"
              ? onStart
              : step === "setup"
                ? undefined
                : step === "permission"
                  ? onPermission
                  : step === "confirm"
                    ? onConfirm
                    : onReady
          }
          disabled={step === "setup" || busy}
        >
          {busy || step === "setup" ? <LoaderCircle className="spin" size={16} /> : null}
          {step === "welcome"
            ? "开始自动设置"
            : step === "setup"
              ? "正在自动设置"
              : step === "permission"
                ? permissionOpened
                  ? "我已授权，继续"
                  : "打开系统设置"
                : step === "confirm"
                  ? "确认并初始化"
                  : "进入新对话"}
          {step === "permission" && !permissionOpened ? <ArrowUpRight size={16} /> : <ArrowRight size={16} />}
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
  diagnose,
  setupLog,
}: {
  step: OnboardingStep;
  diagnose: DiagnoseResult | null;
  setupLog: string;
}) {
  if (step === "setup") {
    return (
      <div className="mock-panel mock-cli compact">
        <div className="mock-line muted">&gt; 自动执行</div>
        <div>checking WeChat.app</div>
        <div>installing wx-cli</div>
        <div>preparing opencli</div>
        <div className="progress-track">
          <span style={{ width: diagnose ? "84%" : "54%" }} />
        </div>
      </div>
    );
  }

  if (step === "permission") {
    return (
      <div className="mock-panel">
        <div className="mock-heading">
          <ShieldCheck size={18} />
          macOS 权限
        </div>
        <div className="permission-card">
          <strong>完全磁盘访问</strong>
          <span>需要用户在系统设置中手动开启</span>
        </div>
        <div className="soft-row">
          <Settings size={17} />
          打开系统设置
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="mock-panel mock-cli dark">
        <div className="mock-line muted">local init</div>
        <div>$ wx init</div>
        <div>$ opencli wx sessions -n 5</div>
        <div className="success-line">ready for local query</div>
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
  setupLog,
  permissionOpened,
}: {
  step: OnboardingStep;
  diagnose: DiagnoseResult | null;
  setupLog: string;
  permissionOpened: boolean;
}) {
  if (step === "welcome") {
    return (
      <div className="card-stack">
        <InfoCard icon={<MessageCircle />} title="读取本机微信记录" text="只读取已同步到 Mac 的本地数据" tone="green" />
        <InfoCard icon={<Terminal />} title="安装 wx-cli 与 opencli" text="桌面端一键处理检查和安装" tone="blue" />
        <InfoCard icon={<Sparkles />} title="完成后直接开始提问" text="用聊天方式查询群聊、联系人和引用" tone="purple" />
      </div>
    );
  }

  if (step === "setup") {
    const checks = diagnose?.checks.slice(2, 7) ?? [
      { key: "wechat", label: "Mac 微信已发现", ok: true, detail: "/Applications/WeChat.app" },
      { key: "tools", label: "正在安装 wx-cli 与 opencli", ok: false, detail: setupLog },
      { key: "keychain", label: "稍后写入 macOS Keychain", ok: false, detail: "密钥不在界面中明文暴露" },
    ];
    return (
      <div className="card-stack">
        {checks.map((check) => (
          <StatusCard key={check.key} ok={check.ok} title={check.label} text={check.detail} />
        ))}
      </div>
    );
  }

  if (step === "permission") {
    return (
      <div className="warning-card">
        <TriangleAlert size={20} />
        <div>
          <strong>{permissionOpened ? "等待重新检查权限" : "尚未授予完全磁盘访问"}</strong>
          <span>{permissionOpened ? "完成授权后点击右下角继续" : "微信数据路径当前不可读取"}</span>
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="code-card">
        <span>将由桌面端执行</span>
        <code>
          wx init
          <br />
          opencli wx sessions -n 5
        </code>
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

function StatusCard({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  return (
    <div className="info-card">
      <div className={`status-icon ${ok ? "ok" : "pending"}`}>{ok ? <CircleCheck /> : <Download />}</div>
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
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
  children,
}: {
  chats: AgentChat[];
  activeChatId: string;
  onNew: () => void;
  onOpen: (id: string) => void;
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
          <Sparkles size={17} />
          新对话
        </button>
        <div className="history-title">对话</div>
        <div className="history-list">
          {chats.map((chat) => (
            <button
              className={`history-item ${chat.id === activeChatId ? "active" : ""}`}
              key={chat.id}
              type="button"
              onClick={() => onOpen(chat.id)}
            >
              <span>{chat.title}</span>
              <small>{chat.updatedAt}</small>
            </button>
          ))}
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
}: {
  chat: AgentChat;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="conversation">
      <header className="conversation-header">
        <strong>{chat.title}</strong>
        <span>•••</span>
      </header>
      <div className="message-column">
        {chat.messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <p>{message.content}</p>
            {message.citations && message.citations.length > 0 && (
              <div className="citation-box">
                {message.citations.map((citation) => (
                  <span key={citation.source}>
                    {citation.label}: <code>{citation.source}</code>
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="conversation-composer">
        <ChatComposer placeholder="要求后续变更" input={input} setInput={setInput} onSubmit={onSubmit} compact />
      </div>
    </div>
  );
}

function ChatComposer({
  placeholder,
  input,
  setInput,
  onSubmit,
  compact = false,
}: {
  placeholder: string;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  compact?: boolean;
}) {
  return (
    <form className={`composer ${compact ? "compact" : ""}`} onSubmit={onSubmit}>
      <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={placeholder} rows={3} />
      <button type="submit" aria-label="发送">
        {compact ? <ArrowUp size={20} /> : <Send size={20} />}
      </button>
    </form>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
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
    return "我还不能确定要检索哪个微信会话，而且当前没有从本机工具里读到可用会话名。请先确认 opencli wx sessions 能列出联系人或群聊，然后在问题里写出明确的群名或联系人名。";
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
    description: "微信助手会自动检查环境、安装 wx-cli / opencli，并在需要你确认时停下来。",
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
    description: "macOS 需要你手动授予完全磁盘访问。授权后回到这里，桌面端会继续验证。",
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

import { Agent, Runner, setDefaultOpenAIClient, setOpenAIAPI, tool } from "@openai/agents";
import { OpenAI } from "openai";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

type RuntimeInput = {
  question: string;
  contextFile?: string | null;
};

type Citation = {
  label: string;
  source: string;
};

type RunContext = {
  citations: Citation[];
  exportDir: string;
  fullScanRequested: boolean;
};

const exportDir = "/tmp/wechat-agent-kit/exports";
const maxToolMessages = 900;
const maxFullScanMessages = 10_000;
const maxToolMessageChars = 80_000;
const maxFullScanMessageChars = 240_000;
const maxLlmContextChars = 32_000;
const maxFullScanLlmContextChars = 240_000;
const defaultHistoryPageSize = 500;
const defaultHistoryLimit = 5_000;
const fullScanFetchPageSize = 5_000;
const maxFullScanExportMessages = 50_000;

type NormalizedWechatMessage = {
  index: number;
  time: string;
  timestamp?: number;
  sender: string;
  type: string;
  content: string;
};

type WechatSession = {
  id: string;
  title: string;
};

type HistoryPageFrom = "latest" | "oldest";

const listWechatSessionsTool = tool({
  name: "list_wechat_sessions",
  description: "列出本机微信最近会话，用于确定用户问题指向哪个群聊或联系人。",
  parameters: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  strict: true,
  execute: async ({ limit }) => {
    emit({ type: "tool_start", tool: "list_wechat_sessions", label: "读取微信会话", input: { limit } });
    const result = await runWx(["sessions", "-n", String(limit), "--json"]);
    const sessions = parseSessions(result.stdout).slice(0, limit);
    emit({
      type: "tool_done",
      tool: "list_wechat_sessions",
      label: "读取微信会话",
      summary: sessions.length > 0 ? `读到 ${sessions.length} 个会话` : "没有读到可用会话",
      ok: true,
    });
    return JSON.stringify({ sessions });
  },
});

const exportWechatHistoryTool = tool({
  name: "export_wechat_history",
  description: [
    "导出指定微信会话的一段聊天历史。",
    "返回 JSON contract: schemaVersion=wechat.history.v1, session, since, requestedLimit, messageCount, returnedMessageCount, timeRange, pagination, messages, truncated, llmContext。",
    "messages 是标准化后的微信消息数组，字段包含 index、time、timestamp、sender、type、content。",
    "默认从最新消息页开始返回，messages 在每页内部保持从旧到新的阅读顺序。",
    "当用户问题要求全部、所有、完整、整体或全量分析时，本工具会自动启用 fullScan，一次返回尽量完整的导出范围；此时不需要你自行重复分页，除非 response.truncated=true。",
    "如果 pagination.hasNextPage=true，可用 pagination.nextOffset 再次调用本工具继续向更早的消息翻页。",
    "truncated=true 表示只返回了部分消息；此时不能声称已经完整阅读全部历史，应继续分页读取、说明范围限制，或要求缩小时间范围。",
  ].join("\n"),
  parameters: z.object({
    session: z.string().min(1).describe("微信会话名、群名、联系人名或 wx/opencli 可识别的 session id"),
    since: z.string().min(8).default(defaultSince()).describe("开始日期，YYYY-MM-DD"),
    limit: z.number().int().min(1).max(maxFullScanExportMessages).default(defaultHistoryLimit).describe("从 wx CLI 导出的最大消息数"),
    offset: z.number().int().min(0).default(0).describe("分页起点。第一页为 0，下一页使用 pagination.nextOffset"),
    pageSize: z.number().int().min(1).max(maxToolMessages).default(defaultHistoryPageSize).describe("本次返回给模型的最大消息条数"),
    pageFrom: z.enum(["latest", "oldest"]).default("latest").describe("分页方向。latest 表示从最新消息往更早消息翻页；oldest 表示从最早消息往更新消息翻页"),
  }),
  strict: true,
  execute: async ({ session, since, limit, offset, pageSize, pageFrom }, runContext) => {
    const activeContext = runContext?.context as RunContext | undefined;
    const fullScan = activeContext?.fullScanRequested === true;
    const safeLimit = fullScan
      ? Math.min(Math.max(limit, fullScanFetchPageSize), maxFullScanExportMessages)
      : Math.min(Math.max(limit, 1), maxFullScanExportMessages);
    const safeOffset = fullScan ? 0 : Math.max(offset, 0);
    const safePageSize = fullScan
      ? maxFullScanMessages
      : Math.min(Math.max(pageSize, 1), maxToolMessages);
    const safePageFrom = fullScan ? "oldest" : pageFrom;
    emit({
      type: "tool_start",
      tool: "export_wechat_history",
      label: fullScan ? "全量导出聊天记录" : "导出聊天记录",
      input: { session, since, limit: safeLimit, offset: safeOffset, pageSize: safePageSize, pageFrom: safePageFrom, fullScan },
    });
    const result = fullScan
      ? await exportFullWechatHistory(session, since, safeLimit)
      : await runWx(["history", session, "--since", since, "-n", String(safeLimit), "--json"]);
    await mkdir(exportDir, { recursive: true });
    const file = path.join(exportDir, `${safeFilePart(session)}-${timestamp()}.json`);
    await writeFile(file, result.stdout, "utf8");
    const history = buildWechatHistoryResponse(
      result.stdout,
      session,
      since,
      safeLimit,
      safeOffset,
      safePageSize,
      safePageFrom,
      fullScan,
    );
    const citation = { label: `本地导出：${session}`, source: file };
    activeContext?.citations.push(citation);
    emit({
      type: "tool_done",
      tool: "export_wechat_history",
      label: fullScan ? "全量导出聊天记录" : "导出聊天记录",
      summary: history.truncated
        ? `已导出 ${history.messageCount} 条，返回第 ${history.pagination.page} 页 ${history.returnedMessageCount} 条`
        : `已导出 ${history.messageCount} 条消息`,
      ok: true,
      citation,
    });
    return JSON.stringify(history);
  },
});

const searchWechatMessagesTool = tool({
  name: "search_wechat_messages",
  description: "按关键词搜索本机微信记录。适合用户问某个词、事件、人名是否出现过，或不确定具体会话时先探索。",
  parameters: z.object({
    keyword: z.string().min(1),
    since: z.string().min(8).default(defaultSince()),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  strict: true,
  execute: async ({ keyword, since, limit }) => {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    emit({
      type: "tool_start",
      tool: "search_wechat_messages",
      label: "搜索微信记录",
      input: { keyword, since, limit: safeLimit },
    });
    const result = await runWx(["search", keyword, "--since", since, "-n", String(safeLimit), "--json"]);
    emit({
      type: "tool_done",
      tool: "search_wechat_messages",
      label: "搜索微信记录",
      summary: `搜索完成，返回 ${formatBytes(result.stdout.length)}`,
      ok: true,
    });
    return result.stdout.slice(0, 32_000);
  },
});

function configureModel() {
  const apiKey =
    process.env.AGENT_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.QWEN_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 AGENT_API_KEY、DASHSCOPE_API_KEY、QWEN_API_KEY 或 OPENAI_API_KEY。");
  }

  const baseURL =
    process.env.AGENT_BASE_URL ||
    process.env.DASHSCOPE_BASE_URL ||
    process.env.QWEN_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
      ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
      : undefined);

  const client = new OpenAI({
    apiKey,
    baseURL,
  });

  setDefaultOpenAIClient(client as any);
  setOpenAIAPI("chat_completions");
}

function createAgent() {
  return new Agent<RunContext>({
    name: "WeChat Local Analyst",
    instructions: [
      "你是一个本机微信记录分析助手。",
      "你必须优先通过工具读取本机微信会话和聊天记录，不能假装已经看过微信内容。",
      "如果输入里包含“已预先定位到会话”，必须优先使用该会话调用 export_wechat_history，不要再把会话名当关键词搜索。",
      "如果输入里包含“候选会话”，先判断候选 chat name 是否匹配用户意图；明显匹配时直接调用 export_wechat_history，不要把候选会话名当关键词搜索。",
      "如果输入里包含“最近会话列表”，先判断用户是在找群/联系人还是搜索消息内容；找群/联系人时优先从会话名选择，只有内容关键词问题才调用 search_wechat_messages。",
      "如果用户问题没有明确群名或联系人，先调用 list_wechat_sessions，再根据会话名判断；仍然不确定时，用自然语言请用户补充明确会话名。",
      "回答要简洁、具体、可核对。不要暴露 username、chatroom id、message id、local_id、JSON、文件路径或内部实现细节。",
      "export_wechat_history 的 tool response 是 wechat.history.v1：默认 pageFrom=latest，从最新消息页开始；messages 在每页内部保持从旧到新。",
      "messageCount 是导出的总消息数，returnedMessageCount 是本次返回给你的消息数；优先阅读 messages 与 llmContext。",
      "如果用户要求全部、所有、完整、整体或全量分析，export_wechat_history 会自动启用 fullScan；只要 truncated=false，就可以把本次导出范围视为已完整读取，不需要再重复分页。",
      "如果 tool response 的 pagination.hasNextPage=true，并且用户要求分析全部/整体/所有消息，应使用 pagination.nextOffset 继续调用 export_wechat_history 读取更早一页，再综合回答。",
      "如果 tool response 的 truncated=true，你只能基于已读取页面回答，不能声称已经完整分析全部 messageCount 条消息。",
      "如果当前可见聊天记录不足以支持结论，明确说“当前可见聊天记录不足以判断”。",
      "默认检索最近 6 个月；如果用户给出更明确时间范围，按用户时间范围使用工具。",
      "不要代发微信消息，不要输出隐私敏感信息。对外分享建议脱敏。",
    ].join("\n"),
    model:
      process.env.AGENT_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      process.env.QWEN_MODEL ||
      process.env.OPENAI_MODEL ||
      "deepseek-v4-pro",
    tools: [listWechatSessionsTool, exportWechatHistoryTool, searchWechatMessagesTool],
    modelSettings: {
      temperature: 0.2,
    },
  });
}

async function runWx(args: string[]) {
  const cwd = process.env.HOME ? path.join(process.env.HOME, ".wx-cli") : undefined;
  if (cwd) await mkdir(cwd, { recursive: true });

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const opencli = spawn("opencli", ["wx", ...args], { cwd });
    collectProcess(opencli)
      .then(resolve)
      .catch(() => {
        const wx = spawn("wx", args, { cwd });
        collectProcess(wx).then(resolve).catch(reject);
      });
  });
}

async function exportFullWechatHistory(session: string, since: string, maxMessages: number) {
  let offset = 0;
  let chat = session;
  let chatType: unknown;
  let isGroup: unknown;
  const messages: unknown[] = [];
  const pages: Array<{ offset: number; count: number; bytes: number }> = [];

  while (messages.length < maxMessages) {
    const pageLimit = Math.min(fullScanFetchPageSize, maxMessages - messages.length);
    const result = await runWx([
      "history",
      session,
      "--since",
      since,
      "--offset",
      String(offset),
      "-n",
      String(pageLimit),
      "--json",
    ]);
    const value = parseJsonObject(result.stdout);
    const pageMessages = readMessageArray(value);
    if (typeof value?.chat === "string") chat = value.chat;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      chatType = record.chat_type ?? chatType;
      isGroup = record.is_group ?? isGroup;
    }

    pages.push({ offset, count: pageMessages.length, bytes: result.stdout.length });
    messages.push(...pageMessages);

    if (pageMessages.length < pageLimit) break;
    offset += pageMessages.length;
  }

  return {
    stdout: JSON.stringify({
      chat,
      chat_type: chatType,
      is_group: isGroup,
      full_scan: true,
      full_scan_pages: pages,
      messages,
    }),
    stderr: "",
  };
}

function collectProcess(child: ReturnType<typeof spawn>) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `wx command exited with status ${code}`).trim()));
      }
    });
  });
}

function parseSessions(output: string): WechatSession[] {
  try {
    const value = JSON.parse(output);
    const array = Array.isArray(value) ? value : Array.isArray(value.sessions) ? value.sessions : [];
    return array
      .map((item: unknown, index: number) => {
        const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const id = pickString(record, ["id", "username", "userName", "wxid", "roomId", "room_id"]) || `session_${index}`;
        const title =
          pickString(record, [
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
          ]) || id;
        return { id, title };
      })
      .filter((session: { id: string; title: string }) => session.title && !session.title.startsWith("{"));
  } catch {
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((line) => ({ id: line, title: line }));
  }
}

async function buildSessionHint(question: string) {
  const hardMatchThreshold = 0.88;
  const candidateThreshold = 0.35;

  emit({
    type: "tool_start",
    tool: "resolve_wechat_session",
    label: "定位微信会话",
    input: { query: question, limit: 50 },
  });

  try {
    const result = await runWx(["sessions", "-n", "50", "--json"]);
    const sessions = parseSessions(result.stdout);
    const rankedSessions = rankSessions(question, sessions);
    const candidates = rankedSessions.slice(0, 10);
    const recentSessions = sessions.slice(0, 30);
    const best = rankedSessions[0];

    if (best && best.score >= hardMatchThreshold) {
      emit({
        type: "tool_done",
        tool: "resolve_wechat_session",
        label: "定位微信会话",
        summary: `高置信匹配「${best.session.title}」`,
        ok: true,
      });
      return [
        "已预先定位到会话：",
        `- session: ${best.session.id}`,
        `- title: ${best.session.title}`,
        `- confidence: ${best.score.toFixed(2)}`,
        "请优先使用这个 session 调用 export_wechat_history。只有导出失败时，才考虑列会话或搜索消息。",
      ].join("\n");
    }

    if (best && best.score >= candidateThreshold) {
      emit({
        type: "tool_done",
        tool: "resolve_wechat_session",
        label: "定位微信会话",
        summary: `找到 ${candidates.length} 个候选，交给 agent 判断`,
        ok: true,
      });

      return [
        "候选会话：",
        ...candidates.map(
          (item, index) =>
            `${index + 1}. title: ${item.session.title}; session: ${item.session.id}; score: ${item.score.toFixed(2)}`,
        ),
        "请先判断这些 chat name 是否表达了用户意图。",
        "如果一个候选明显匹配，直接用它的 session 调用 export_wechat_history。",
        "不要把候选标题、群名或联系人名当关键词调用 search_wechat_messages。",
        "只有候选都不匹配、且用户问题像是在找消息内容时，才使用 search_wechat_messages；仍不确定时请用户补充。",
      ].join("\n");
    }

    emit({
      type: "tool_done",
      tool: "resolve_wechat_session",
      label: "定位微信会话",
      summary: recentSessions.length > 0 ? `未命中，提供最近 ${recentSessions.length} 个会话给 agent 判断` : "未找到可用会话",
      ok: true,
    });

    if (recentSessions.length === 0) return "";
    return [
      "最近会话列表：",
      ...recentSessions.map((session, index) => `${index + 1}. title: ${session.title}; session: ${session.id}`),
      "请根据用户问题判断下一步：",
      "1. 如果用户像是在找某个群、联系人或会话，先从最近会话列表中选择最可能的 session 调用 export_wechat_history。",
      "2. 如果用户是在查某个事件、人名或消息内容，调用 search_wechat_messages。",
      "3. 如果无法判断目标会话或搜索词，请简短要求用户补充信息。",
    ].join("\n");
  } catch (error) {
    emit({
      type: "tool_done",
      tool: "resolve_wechat_session",
      label: "定位微信会话",
      summary: `定位失败：${errorMessage(error)}`,
      ok: false,
    });
    return "";
  }
}

function rankSessions(question: string, sessions: WechatSession[]) {
  const normalizedQuestion = normalizeSessionText(question);
  return sessions
    .map((session) => {
      const normalizedTitle = normalizeSessionText(session.title);
      return {
        session,
        score: sessionMatchScore(normalizedQuestion, normalizedTitle),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function sessionMatchScore(question: string, title: string) {
  if (!question || !title) return 0;
  if (question === title) return 1;
  if (question.includes(title)) return title.length >= 2 ? 0.96 : 0.2;
  if (title.includes(question)) return question.length >= 2 ? 0.92 : 0.2;
  const coreQuestion = question.replace(/在哪里|哪里|在哪/g, "");
  if (coreQuestion.length >= 3 && title.includes(coreQuestion)) return 0.86;

  const titleChars = new Set(title.split(""));
  const sharedChars = question.split("").filter((char) => titleChars.has(char)).length;
  const charScore = sharedChars / Math.max(title.length, 1);
  const gramScore = ngramOverlap(question, title);
  return Math.max(charScore * 0.65, gramScore);
}

function ngramOverlap(left: string, right: string) {
  const leftGrams = ngrams(left, 2);
  const rightGrams = ngrams(right, 2);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let shared = 0;
  for (const gram of rightGrams) {
    if (leftGrams.has(gram)) shared += 1;
  }
  return shared / rightGrams.size;
}

function ngrams(value: string, size: number) {
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return grams;
}

function normalizeSessionText(value: string) {
  return value
    .toLowerCase()
    .replace(/哪儿/g, "哪里")
    .replace(/在哪/g, "在哪里")
    .replace(/说错了/g, "")
    .replace(/不是/g, "")
    .replace(/是/g, "")
    .replace(/帮我/g, "")
    .replace(/看看/g, "")
    .replace(/[\s"'“”‘’`.,，。！？!?、:：;；()[\]{}<>《》~～_\-]/g, "");
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const key of ["contact", "user", "profile", "conversation", "session", "room"]) {
    const value = record[key];
    if (value && typeof value === "object") {
      const nested = pickString(value as Record<string, unknown>, keys);
      if (nested) return nested;
    }
  }

  return undefined;
}

function buildWechatHistoryResponse(
  raw: string,
  session: string,
  since: string,
  requestedLimit: number,
  offset: number,
  pageSize: number,
  pageFrom: HistoryPageFrom,
  fullScan: boolean,
) {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    const contextCharLimit = fullScan ? maxFullScanLlmContextChars : maxLlmContextChars;
    const llmContext = raw.slice(0, contextCharLimit);
    return {
      schemaVersion: "wechat.history.v1",
      session,
      since,
      requestedLimit,
      fullScan,
      bytes: raw.length,
      messageCount: 0,
      returnedMessageCount: 0,
      timeRange: null,
      pagination: {
        offset,
        pageSize,
        pageFrom,
        page: 1,
        totalPages: 0,
        hasNextPage: false,
        nextOffset: null,
        previousOffset: offset > 0 ? Math.max(offset - pageSize, 0) : null,
        returnedRange: null,
      },
      messages: [],
      truncated: raw.length > contextCharLimit,
      truncation: raw.length > contextCharLimit ? { reason: "raw_text_too_large", omittedMessageCount: null } : null,
      llmContext,
      notes: "wx history did not return valid JSON; llmContext contains raw text.",
    };
  }

  const chat = typeof value.chat === "string" ? value.chat : session;
  const allMessages = readMessageArray(value)
    .map(normalizeWechatMessage)
    .filter((message) => message.content)
    .sort(compareMessagesByTime);
  const selectionOptions = fullScan
    ? {
        maxMessages: maxFullScanMessages,
        maxChars: maxFullScanMessageChars,
      }
    : {
        maxMessages: maxToolMessages,
        maxChars: maxToolMessageChars,
      };
  const page = selectMessagesForTool(allMessages, offset, pageSize, pageFrom, selectionOptions);
  const returnedMessages = page.messages;
  const truncated = page.hasNextPage || offset > 0 || allMessages.length > returnedMessages.length;

  return {
    schemaVersion: "wechat.history.v1",
    session: chat,
    since,
    requestedLimit,
    fullScan,
    bytes: raw.length,
    messageCount: allMessages.length,
    returnedMessageCount: returnedMessages.length,
    timeRange: buildTimeRange(allMessages),
    pagination: {
      offset,
      pageSize,
      pageFrom,
      page: Math.floor(offset / pageSize) + 1,
      totalPages: Math.ceil(allMessages.length / pageSize),
      hasNextPage: page.hasNextPage,
      nextOffset: page.nextOffset,
      previousOffset: offset > 0 ? Math.max(offset - pageSize, 0) : null,
      returnedRange:
        returnedMessages.length > 0
          ? {
              startIndex: returnedMessages[0].index,
              endIndex: returnedMessages[returnedMessages.length - 1].index,
            }
          : null,
    },
    messages: returnedMessages,
    truncated,
    truncation: truncated
      ? {
          reason: "message_count_exceeds_page_budget",
          maxReturnedMessages: selectionOptions.maxMessages,
          maxReturnedContentChars: selectionOptions.maxChars,
          omittedMessageCount: Math.max(allMessages.length - (offset + returnedMessages.length), 0),
        }
      : null,
    llmContext: buildLlmContext(chat, returnedMessages, truncated, allMessages.length, pageFrom, offset, fullScan),
    notes: truncated
      ? pageFrom === "latest"
        ? "Only the current page is included. Use pagination.nextOffset with pageFrom=latest to fetch the next older page before making whole-history claims."
        : "Only the current page is included. Use pagination.nextOffset with pageFrom=oldest to fetch the next newer page before making whole-history claims."
      : fullScan
        ? "Full-scan mode is active. All parsed messages inside the exported limit are included in this tool response."
        : "All parsed messages are included in this tool response.",
  };
}

function normalizeWechatMessage(item: unknown, index: number): NormalizedWechatMessage {
  const timestamp = readNumber(item, "timestamp");
  return {
    index,
    time: readText(item, "time") || (timestamp ? new Date(timestamp * 1000).toISOString() : "未知时间"),
    timestamp,
    sender: readText(item, "sender") || readText(item, "from") || readText(item, "speaker") || "未知发送者",
    type: readText(item, "type") || "消息",
    content: (readText(item, "content") || readText(item, "summary") || readText(item, "text") || "").trim(),
  };
}

function compareMessagesByTime(left: NormalizedWechatMessage, right: NormalizedWechatMessage) {
  if (left.timestamp !== undefined && right.timestamp !== undefined) {
    return left.timestamp - right.timestamp;
  }
  if (left.timestamp !== undefined) return -1;
  if (right.timestamp !== undefined) return 1;
  return left.index - right.index;
}

function selectMessagesForTool(
  messages: NormalizedWechatMessage[],
  offset: number,
  pageSize: number,
  pageFrom: HistoryPageFrom,
  options: { maxMessages: number; maxChars: number } = { maxMessages: maxToolMessages, maxChars: maxToolMessageChars },
) {
  const selected: NormalizedWechatMessage[] = [];
  let contentChars = 0;
  const pageLimit = Math.min(pageSize, options.maxMessages);
  const source = pageFrom === "latest" ? messages.slice(0, Math.max(messages.length - offset, 0)).reverse() : messages.slice(offset);

  for (const message of source) {
    if (selected.length >= pageLimit) break;
    const nextChars = message.time.length + message.sender.length + message.type.length + message.content.length;
    if (selected.length > 0 && contentChars + nextChars > options.maxChars) break;
    if (pageFrom === "latest") {
      selected.unshift(message);
    } else {
      selected.push(message);
    }
    contentChars += nextChars;
  }

  const nextOffset = offset + selected.length;
  return {
    messages: selected,
    hasNextPage: nextOffset < messages.length,
    nextOffset: nextOffset < messages.length ? nextOffset : null,
  };
}

function buildTimeRange(messages: NormalizedWechatMessage[]) {
  if (messages.length === 0) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    start: first.time,
    end: last.time,
  };
}

function buildLlmContext(
  chat: string,
  messages: NormalizedWechatMessage[],
  truncated: boolean,
  totalMessageCount: number,
  pageFrom: HistoryPageFrom,
  offset: number,
  fullScan: boolean,
) {
  const lines = [
    `会话：${chat}`,
    `消息数量：本次返回 ${messages.length} 条；导出总数 ${totalMessageCount} 条；模式：${fullScan ? "全量扫描" : "分页读取"}；分页方向：${pageFrom === "latest" ? "从最新向更早翻页" : "从最早向更新翻页"}；offset=${offset}；是否截断：${truncated ? "是" : "否"}`,
  ];

  for (const message of messages) {
    lines.push(`[${message.time}] ${message.sender}（${message.type}）：${message.content}`);
  }

  return lines.join("\n").slice(0, fullScan ? maxFullScanLlmContextChars : maxLlmContextChars);
}

function readMessageArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  for (const key of ["messages", "data", "items", "records", "history"]) {
    const field = record[key];
    if (Array.isArray(field)) return field;
  }

  return [];
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown, key: string) {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function readNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function defaultSince() {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  return date.toISOString().slice(0, 10);
}

function timestamp() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function safeFilePart(value: string) {
  return value
    .split("")
    .map((char) => (/[\w.-]/.test(char) ? char : "-"))
    .join("")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "wechat";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function emit(payload: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function readInput(): Promise<RuntimeInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RuntimeInput;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

async function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    const value = unquoteEnvValue(line.slice(index + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function main() {
  const input = await readInput();
  const context: RunContext = {
    citations: [],
    exportDir,
    fullScanRequested: wantsFullHistory(input.question),
  };

  emit({ type: "status", message: "理解问题，准备本地微信工具" });
  await loadDotEnv();
  configureModel();

  const agent = createAgent();
  const sessionHint = await buildSessionHint(input.question);
  const fullScanHint = context.fullScanRequested
    ? "已检测到用户要求完整/全量读取：调用 export_wechat_history 时会自动进入 fullScan。若工具返回 truncated=false，不要再重复分页。"
    : "";
  const agentInput = [sessionHint, fullScanHint, `用户问题：${input.question}`].filter(Boolean).join("\n\n");
  const runner = new Runner({ tracingDisabled: true });
  const stream = await runner.run(agent, agentInput, {
    context,
    maxTurns: 16,
    stream: true,
  });

  let answer = "";
  const textStream = stream.toTextStream();
  for await (const delta of textStream) {
    answer += delta;
    emit({ type: "delta", delta });
  }

  await stream.completed;
  emit({ type: "done", answer: answer || String(stream.finalOutput ?? ""), citations: context.citations });
}

function wantsFullHistory(question: string) {
  return /全部(?:的)?(?:消息|聊天|聊天记录|记录|内容)|所有(?:的)?(?:消息|聊天|聊天记录|记录|内容)|完整(?:的)?(?:聊天|聊天记录|记录|消息|内容|分析)|全量|整体分析|全面(?:的)?分析|重新、?全面|整个群|全群/.test(
    question,
  );
}

try {
  await main();
} catch (error) {
  emit({ type: "error", message: errorMessage(error) });
  process.exitCode = 1;
}

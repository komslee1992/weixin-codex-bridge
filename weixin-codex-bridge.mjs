import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { isLoggedIn, login, start } from "weixin-agent-sdk";
import { AcpAgent } from "weixin-acp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "weixin-bridge.config.json");
const STATE_PATH = path.join(__dirname, "weixin-bridge.state.json");
const LOG_PATH = path.join(__dirname, "weixin-bridge.log");
const SYNC_LOG_PATH = path.join(__dirname, "weixin-sync.jsonl");
const NOTIFY_QUEUE_PATH = path.join(__dirname, "weixin-notify-queue.jsonl");
const BIND_PHRASE = process.env.WEIXIN_BIND_PHRASE || "绑定Codex";
const POLICY_CONFIRM_PHRASE = "确认高权限";
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_TIMEOUT_MS = 5 * 60 * 1000;
const NOTIFY_POLL_MS = 3000;

let notifyRetryAfter = 0;

function now() {
  return new Date().toISOString();
}

function log(message) {
  rotateFileIfLarge(LOG_PATH);
  const line = `[${now()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}

function syncLog(event) {
  rotateFileIfLarge(SYNC_LOG_PATH);
  fs.appendFileSync(SYNC_LOG_PATH, `${JSON.stringify({ ts: now(), ...event })}\n`, "utf8");
}

function syncRouteChanged(conversationId, reason, state) {
  syncLog({
    event: "route_changed",
    conversationId,
    reason,
    state,
  });
}

function readSyncSnapshot(limit = 40) {
  const events = [];
  if (fs.existsSync(SYNC_LOG_PATH)) {
    const lines = fs.readFileSync(SYNC_LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-limit)) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  }

  return {
    state: readState(),
    config: readConfig(),
    syncLogPath: SYNC_LOG_PATH,
    notifyQueuePath: NOTIFY_QUEUE_PATH,
    events,
  };
}

function enqueueNotification(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Notification text is empty.");
  }

  rotateFileIfLarge(NOTIFY_QUEUE_PATH);
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: now(),
    text: trimmed,
  };
  fs.appendFileSync(NOTIFY_QUEUE_PATH, `${JSON.stringify(item)}\n`, "utf8");
  log(`[notify] queued ${item.id}`);
  return item;
}

function readNotificationQueue() {
  if (!fs.existsSync(NOTIFY_QUEUE_PATH)) return [];
  const items = [];
  for (const line of fs.readFileSync(NOTIFY_QUEUE_PATH, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      if (item?.id && item?.text) items.push(item);
    } catch {}
  }
  return items;
}

function writeNotificationQueue(items) {
  if (!items.length) {
    if (fs.existsSync(NOTIFY_QUEUE_PATH)) fs.unlinkSync(NOTIFY_QUEUE_PATH);
    return;
  }

  const tmpPath = `${NOTIFY_QUEUE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.renameSync(tmpPath, NOTIFY_QUEUE_PATH);
}

async function processNotificationQueue(bot, config) {
  if (Date.now() < notifyRetryAfter) return;

  const items = readNotificationQueue();
  if (!items.length) return;

  const remaining = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      await bot.sendMessage(item.text);
      log(`[notify] sent ${item.id}`);
      syncLog({
        event: "desktop_notification",
        direction: "out",
        conversationId: config.allowedConversationId || "",
        text: item.text,
        notifyId: item.id,
      });
    } catch (error) {
      remaining.push(...items.slice(index));
      notifyRetryAfter = Date.now() + 15000;
      log(`[notify] failed ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  if (!remaining.length) notifyRetryAfter = 0;
  writeNotificationQueue(remaining);
}

function startNotificationPump(bot, config, abortSignal) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processNotificationQueue(bot, config);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch((error) => log(`[notify] pump error: ${error instanceof Error ? error.message : String(error)}`));
  }, NOTIFY_POLL_MS);
  timer.unref?.();
  abortSignal?.addEventListener("abort", () => clearInterval(timer), { once: true });
  tick().catch((error) => log(`[notify] pump error: ${error instanceof Error ? error.message : String(error)}`));
}

function rotateFileIfLarge(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    if (fs.statSync(filePath).size < LOG_MAX_BYTES) return;
    fs.renameSync(filePath, `${filePath}.${Date.now()}.old`);
  } catch {}
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      allowedConversationId: "",
      bindPhrase: BIND_PHRASE,
      createdAt: now(),
      workspace: __dirname,
    };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      mode: "live",
      activeResumeSessionId: "",
      policy: "safe",
      responseMode: "light",
      updatedAt: now(),
    };
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return {
    policy: "safe",
    responseMode: "light",
    ...state,
  };
}

function writeState(state) {
  state.updatedAt = now();
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resetConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
  }
  log("Whitelist config and bridge state reset.");
}

function localCodexAcpCommand() {
  const cmdName = process.platform === "win32" ? "codex-acp.cmd" : "codex-acp";
  return path.join(__dirname, "node_modules", ".bin", cmdName);
}

function normalizePolicy(policy) {
  return policy === "unsafe" ? "unsafe" : "safe";
}

function policyArgs(policy) {
  const normalized = normalizePolicy(policy);
  return [
    "-c",
    `approval_policy="never"`,
    "-c",
    `sandbox_mode="${normalized === "unsafe" ? "danger-full-access" : "workspace-write"}"`,
  ];
}

function formatPolicy(policy) {
  const normalized = normalizePolicy(policy);
  if (normalized === "unsafe") {
    return "unsafe，高权限：sandbox_mode=danger-full-access，approval_policy=never";
  }
  return "safe，默认安全：sandbox_mode=workspace-write，approval_policy=never";
}

function normalizeResponseMode(mode) {
  return mode === "full" ? "full" : "light";
}

function shouldUseFullResponse(text, state) {
  const trimmed = String(text || "").trim();
  if (normalizeResponseMode(state.responseMode) === "full") return true;
  return /^(详细|完整|深入|执行|任务|代码|查一下|搜索|修复|实现|部署|安装|运行|分析)[:：\s]/i.test(trimmed);
}

function wrapWechatPrompt(text, state) {
  if (shouldUseFullResponse(text, state)) return text;
  return [
    "这是微信端轻量沟通模式。请用很短的中文回复，默认 1-3 句，少展开，少列点，不主动长篇解释。",
    "如果用户明确要求执行任务、写代码、查资料、深入分析，再正常展开。",
    "",
    "用户消息：",
    text || "",
  ].join("\n");
}

function createAcpAgent(policy) {
  const command = localCodexAcpCommand();
  return new AcpAgent({
    command,
    args: policyArgs(policy),
    cwd: __dirname,
  });
}

function codexCommand() {
  return path.join(__dirname, "run-codex-resume.cmd");
}

function sessionIndexPath() {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function readCodexSessions(limit = 10) {
  const indexPath = sessionIndexPath();
  if (!fs.existsSync(indexPath)) return [];

  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter(Boolean);
  const sessions = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.id && item.thread_name) sessions.push(item);
    } catch {}
  }

  return sessions
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, limit);
}

function findSessionFile(sessionId) {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  const stack = [sessionsDir];

  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        return full;
      }
    }
  }

  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function readSessionTranscript(sessionId, maxChars = 14000) {
  const file = findSessionFile(sessionId);
  if (!file) return { file: "", text: "" };

  const messages = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "response_item") continue;
      const payload = event.payload;
      if (payload?.type !== "message") continue;
      const role = payload.role === "user" ? "User" : payload.role === "assistant" ? "Assistant" : "";
      if (!role) continue;
      const text = contentToText(payload.content).trim();
      if (!text || text.startsWith("<environment_context>")) continue;
      messages.push(`${role}: ${text.slice(0, 1800)}`);
    } catch {}
  }

  let selected = [];
  let used = 0;
  for (const message of messages.reverse()) {
    used += message.length;
    if (used > maxChars) break;
    selected.push(message);
  }

  return { file, text: selected.reverse().join("\n\n") };
}

function formatSessions(sessions, options = {}) {
  const prefix = options.includeNew ? "0. 开启新对话\n/resume 0 或 /resume new\n\n" : "";
  if (!sessions.length) return `${prefix}没有找到可恢复的 Codex 会话。`;
  return prefix + sessions
    .map((session, index) => {
      const updated = String(session.updated_at || "").replace("T", " ").replace(/Z$/, "");
      return `${index + 1}. ${session.thread_name}\n${session.id}\n${updated}`;
    })
    .join("\n\n");
}

function resolveSessionRef(ref) {
  const sessions = readCodexSessions(20);
  const token = String(ref || "").trim();
  if (!token) return { sessions };

  if (/^\d+$/.test(token)) {
    const index = Number(token) - 1;
    if (sessions[index]) return { session: sessions[index], sessions };
  }

  const byId = sessions.find((session) => session.id === token || session.id.startsWith(token));
  if (byId) return { session: byId, sessions };

  const lower = token.toLowerCase();
  const byName = sessions.find((session) => String(session.thread_name).toLowerCase().includes(lower));
  if (byName) return { session: byName, sessions };

  return { sessions };
}

function runCodexResume(sessionId, prompt) {
  return new Promise((resolve) => {
    const outputPath = path.join(__dirname, "logs", `resume-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const policy = readState().policy;
    const args = [
      "--skip-git-repo-check",
      ...policyArgs(policy),
      "-o",
      outputPath,
      sessionId,
      "-",
    ];

    const command = codexCommand();
    log(`[resume] spawning: ${command} ${args.slice(0, -1).join(" ")} <prompt>`);
    const child = spawn(command, args, {
      cwd: __dirname,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, text: "恢复会话超时，已终止本次 resume 子进程。" });
    }, RESUME_TIMEOUT_MS);

    child.stdin?.end(prompt);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish({ ok: false, text: `恢复会话失败：${error.message}` });
    });

    child.on("close", (code) => {
      const output = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf8").trim()
        : stdout.trim();
      if (code === 0 && output) {
        finish({ ok: true, text: output });
        return;
      }

      const detail = (stderr || stdout || `codex exited with code ${code}`).trim();
      finish({ ok: false, text: `恢复会话失败：${detail.slice(0, 1200)}` });
    });
  });
}

async function runInjectedResume(inner, conversationId, sessionId, prompt, state) {
  const transcript = readSessionTranscript(sessionId);
  const threadName = state.activeResumeThreadName || sessionId;

  if (!transcript.text) {
    return {
      text: `无法读取旧会话记录，不能注入上下文：${sessionId}`,
    };
  }

  const alreadyInjected = state.injectedResumeSessionId === sessionId;
  let text = wrapWechatPrompt(prompt, state);
  if (!alreadyInjected) {
    inner?.clearSession?.(conversationId);
    const wrappedPrompt = wrapWechatPrompt(prompt, state);
    text = [
      `你正在通过微信继续一个旧 Codex 会话：${threadName}`,
      `旧会话 ID：${sessionId}`,
      `以下是从本机 session jsonl 提取的最近对话上下文。请把它当作当前任务背景继续，不要重新解释桥接机制。`,
      "",
      "<旧会话上下文>",
      transcript.text,
      "</旧会话上下文>",
      "",
      "用户现在的新消息：",
      wrappedPrompt,
    ].join("\n");

    writeState({
      ...state,
      mode: "resume",
      resumeStrategy: "inject",
      injectedResumeSessionId: sessionId,
      injectedFromFile: transcript.file,
    });
  }

  return inner.chat({ conversationId, text });
}

class WhitelistAgent {
  constructor(inner, config, options = {}) {
    this.inner = inner;
    this.config = config;
    this.allowBind = options.allowBind === true;
  }

  switchPolicy(policy) {
    const normalized = normalizePolicy(policy);
    this.inner?.dispose?.();
    this.inner = createAcpAgent(normalized);

    const state = readState();
    writeState({
      ...state,
      policy: normalized,
      injectedResumeSessionId: "",
      switchedPolicyAt: now(),
    });

    log(`Policy switched to ${normalized}`);
  }

  async chat(request) {
    const allowed = this.config.allowedConversationId;
    notifyRetryAfter = 0;
    syncLog({
      direction: "in",
      conversationId: request.conversationId,
      text: request.text || "",
      media: request.media?.type || "",
      state: readState(),
    });

    if (!allowed) {
      if (!this.allowBind) {
        log(`Blocked unbound conversation=${request.conversationId}; run bind mode first.`);
        const response = {};
        syncLog({ direction: "out", conversationId: request.conversationId, text: "", dropped: true, reason: "unbound" });
        return response;
      }

      if ((request.text || "").trim() !== this.config.bindPhrase) {
        log(`Ignoring unbound conversation=${request.conversationId}; waiting for bind phrase.`);
        syncLog({ direction: "out", conversationId: request.conversationId, text: "", dropped: true, reason: "waiting_for_bind_phrase" });
        return {};
      }

      this.config.allowedConversationId = request.conversationId;
      this.config.boundAt = now();
      writeConfig(this.config);
      log(`Bound allowed conversationId=${request.conversationId}`);
      const response = {
        text: "已绑定这个微信会话。之后我只会接收并回复这个会话里的消息。",
      };
      syncLog({ direction: "out", conversationId: request.conversationId, text: response.text });
      return response;
    }

    if (request.conversationId !== allowed) {
      log(`Blocked conversation=${request.conversationId}; allowed=${allowed}`);
      syncLog({ direction: "out", conversationId: request.conversationId, text: "", dropped: true, reason: "not_allowed" });
      return {};
    }

    if ((request.text || "").trim() === "/whoami") {
      const response = { text: `conversationId: ${request.conversationId}` };
      syncLog({ direction: "out", conversationId: request.conversationId, text: response.text });
      return response;
    }

      const commandResponse = await this.handleBridgeCommand(request);
    if (commandResponse) {
      syncLog({ direction: "out", conversationId: request.conversationId, text: commandResponse.text || "", route: "command" });
      return commandResponse;
    }

    const state = readState();
    const promptText = wrapWechatPrompt(request.text || "", state);
    if (state.mode === "resume" && state.activeResumeSessionId) {
      if (state.resumeStrategy !== "inject") {
        const result = await runCodexResume(state.activeResumeSessionId, promptText);
        if (result.ok) {
          const response = { text: result.text };
          syncLog({ direction: "out", conversationId: request.conversationId, text: response.text, route: "codex_exec_resume" });
          return response;
        }
        log(`[resume] CLI resume failed, falling back to context injection: ${result.text.slice(0, 200)}`);
      }

      const response = await runInjectedResume(this.inner, request.conversationId, state.activeResumeSessionId, request.text || "", state);
      syncLog({ direction: "out", conversationId: request.conversationId, text: response.text || "", route: "injected_resume" });
      return response;
    }

    if (!this.inner) {
      const response = { text: "已绑定。现在可以启动 Codex 桥接模式。" };
      syncLog({ direction: "out", conversationId: request.conversationId, text: response.text });
      return response;
    }

    const response = await this.inner.chat({ ...request, text: promptText });
    syncLog({ direction: "out", conversationId: request.conversationId, text: response.text || "", route: "live_acp" });
    return response;
  }

  async handleBridgeCommand(request) {
    const text = (request.text || "").trim();
    if (!text.startsWith("/")) return null;

    const [command, ...rest] = text.split(/\s+/);
    const arg = rest[0] || "";
    const remainingPrompt = rest.slice(1).join(" ").trim();

    if (command === "/help" || command === "/帮助") {
      return {
        text: [
          "微信桥接命令：",
          "/sessions 或 /会话：列出最近 Codex 会话",
          "/resume 0 或 /resume new：开启新对话",
          "/resume <编号|ID|名称>：切到旧会话，之后普通消息继续它",
          "/resume <编号|ID|名称> <问题>：切换并立刻提问",
          "/live 或 /实时：回到当前实时 ACP 会话",
          "/new 或 /新会话：清空当前实时 ACP 会话",
          "/policy：查看权限模式",
          `/policy unsafe ${POLICY_CONFIRM_PHRASE}：切到高权限`,
          "/policy safe：切回安全模式",
          "/mode：查看回复模式",
          "/mode light：微信默认短答省 token",
          "/mode full：微信默认完整回答",
          "/current 或 /当前：查看当前路由状态",
          "/whoami：查看当前微信 conversationId",
        ].join("\n"),
      };
    }

    if (command === "/sessions" || command === "/会话") {
      return { text: formatSessions(readCodexSessions(10), { includeNew: true }) };
    }

    if (command === "/current" || command === "/当前") {
      const state = readState();
      const policyText = `权限：${formatPolicy(state.policy)}`;
      const modeText = `回复：${normalizeResponseMode(state.responseMode) === "full" ? "full 完整回答" : "light 短答省 token"}`;
      if (state.mode === "resume" && state.activeResumeSessionId) {
        return { text: `当前模式：resume\n会话：${state.activeResumeSessionId}\n${policyText}\n${modeText}` };
      }
      return { text: `当前模式：live\n会继续这个桥接进程里的实时 ACP 会话。\n${policyText}\n${modeText}` };
    }

    if (command === "/mode" || command === "/模式") {
      const state = readState();
      if (!arg) {
        return {
          text: [
            `当前回复模式：${normalizeResponseMode(state.responseMode)}`,
            "",
            "切换命令：",
            "/mode light",
            "/mode full",
            "",
            "light：微信端默认 1-3 句短答，省 token。",
            "full：微信端默认完整回答。",
            "自动完整回答：light 模式下，消息以 详细: 或 执行: 开头时，本条会自动按 full 处理，无需确认。",
          ].join("\n"),
        };
      }

      const nextMode = arg === "full" ? "full" : arg === "light" ? "light" : "";
      if (!nextMode) {
        return { text: "未知回复模式。可用：/mode light 或 /mode full" };
      }

      writeState({ ...readState(), responseMode: nextMode });
      return { text: `已切换微信回复模式：${nextMode}` };
    }

    if (command === "/policy" || command === "/权限") {
      const state = readState();
      if (!arg) {
        return {
          text: [
            `当前权限：${formatPolicy(state.policy)}`,
            "",
            "开启高权限：",
            `/policy unsafe ${POLICY_CONFIRM_PHRASE}`,
            "",
            "关闭高权限：",
            "/policy safe",
            "",
            "建议：只在需要排查 Windows sandbox / spawn 问题时临时开启，用完立刻切回 safe。",
            "风险：unsafe 会让微信白名单会话触发的隐藏 Codex 拥有 danger-full-access。",
          ].join("\n"),
        };
      }

      if (arg === "safe") {
        this.switchPolicy("safe");
        return { text: `已切回安全模式。\n${formatPolicy("safe")}` };
      }

      if (arg === "unsafe") {
        const confirmation = rest.slice(1).join(" ").trim();
        if (confirmation !== POLICY_CONFIRM_PHRASE) {
          return {
            text: [
              "未切换。开启高权限需要完整确认命令：",
              `/policy unsafe ${POLICY_CONFIRM_PHRASE}`,
              "",
              "风险：微信白名单会话里的请求会进入 danger-full-access 隐藏 Codex 子进程。",
            ].join("\n"),
          };
        }

        this.switchPolicy("unsafe");
        return { text: `已切到高权限模式。\n${formatPolicy("unsafe")}\n用完请发 /policy safe 切回。` };
      }

      return { text: "未知权限模式。可用：/policy safe 或 /policy unsafe 确认高权限" };
    }

    if (command === "/live" || command === "/实时") {
      const nextState = { ...readState(), mode: "live", activeResumeSessionId: "", activeResumeThreadName: "", injectedResumeSessionId: "", liveConversationStartedAt: now(), liveConversationReason: "live" };
      writeState(nextState);
      syncRouteChanged(request.conversationId, "live", nextState);
      return { text: "已切回 live 模式。之后普通消息会继续当前实时 ACP 会话。" };
    }

    if (command === "/new" || command === "/新会话") {
      this.inner?.clearSession?.(request.conversationId);
      const nextState = { ...readState(), mode: "live", activeResumeSessionId: "", activeResumeThreadName: "", injectedResumeSessionId: "", liveConversationStartedAt: now(), liveConversationReason: "new" };
      writeState(nextState);
      syncRouteChanged(request.conversationId, "new", nextState);
      return { text: "已清空当前实时 ACP 会话。下一条普通消息会创建新会话。" };
    }

    if (command === "/resume" || command === "/继续") {
      if (!arg) {
        return { text: `用法：/resume <0|new|编号|ID|名称>\n\n${formatSessions(readCodexSessions(10), { includeNew: true })}` };
      }

      if (arg === "0" || arg.toLowerCase() === "new" || arg === "新对话") {
        this.inner?.clearSession?.(request.conversationId);
        const nextState = { ...readState(), mode: "live", activeResumeSessionId: "", activeResumeThreadName: "", injectedResumeSessionId: "", liveConversationStartedAt: now(), liveConversationReason: "resume_new" };
        writeState(nextState);
        syncRouteChanged(request.conversationId, "resume_new", nextState);
        return { text: "已开启新对话。下一条普通消息会创建新的实时 ACP 会话。" };
      }

      const { session, sessions } = resolveSessionRef(arg);
      if (!session) {
        return { text: `没找到匹配的会话：${arg}\n\n${formatSessions(sessions.slice(0, 10), { includeNew: true })}` };
      }

      const nextState = {
        ...readState(),
        mode: "resume",
        activeResumeSessionId: session.id,
        activeResumeThreadName: session.thread_name,
        resumeStrategy: "cli",
        injectedResumeSessionId: "",
      };
      writeState(nextState);
      syncRouteChanged(request.conversationId, "resume_existing", nextState);
      this.inner?.clearSession?.(request.conversationId);

      if (!remainingPrompt) {
        return {
          text: `已切到旧会话：${session.thread_name}\n${session.id}\n之后普通消息都会继续这个会话。`,
        };
      }

      const result = await runCodexResume(session.id, remainingPrompt);
      if (result.ok) return { text: result.text };

      log(`[resume] CLI resume failed, falling back to context injection: ${result.text.slice(0, 200)}`);
      const state = readState();
      return runInjectedResume(this.inner, request.conversationId, session.id, remainingPrompt, state);
    }

    return null;
  }

  clearSession(conversationId) {
    if (conversationId === this.config.allowedConversationId) {
      this.inner.clearSession?.(conversationId);
    }
  }

  dispose() {
    this.inner?.dispose?.();
  }
}

async function runBridge() {
  process.env.WEIXIN_BRIDGE_DISABLE_SLASH = "1";

  if (!isLoggedIn()) {
    log("No stored Weixin login found; starting QR login.");
    await login();
  }

  const config = readConfig();
  if (!config.allowedConversationId) {
    throw new Error(`No whitelist bound. Run bind mode first and send "${config.bindPhrase}" from your WeChat.`);
  }
  log(`Using whitelist conversationId=${config.allowedConversationId}`);

  const codexCommand = localCodexAcpCommand();
  if (!fs.existsSync(codexCommand)) {
    throw new Error(`codex-acp not found at ${codexCommand}`);
  }

  const inner = new AcpAgent({
    command: codexCommand,
    args: policyArgs(readState().policy),
    cwd: __dirname,
  });

  const agent = new WhitelistAgent(inner, config);
  const ac = new AbortController();

  process.on("SIGINT", () => {
    log("Stopping bridge.");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    log("Stopping bridge.");
    agent.dispose();
    ac.abort();
  });

  const bot = start(agent, {
    abortSignal: ac.signal,
    log,
  });

  startNotificationPump(bot, config, ac.signal);
  log("Weixin Codex bridge started.");
  await bot.wait();
}

async function runBind() {
  process.env.WEIXIN_BRIDGE_DISABLE_SLASH = "1";

  if (!isLoggedIn()) {
    log("No stored Weixin login found; starting QR login.");
    await login();
  }

  const config = readConfig();
  if (config.allowedConversationId) {
    log(`Already bound allowed conversationId=${config.allowedConversationId}`);
  } else {
    writeConfig(config);
    log(`Bind mode started. Send "${config.bindPhrase}" from your WeChat to bind.`);
  }

  const agent = new WhitelistAgent(null, config, { allowBind: true });
  const bot = start(agent, { log });
  await bot.wait();
}

const command = process.argv[2] || "start";

if (command === "status") {
  console.log(JSON.stringify({
    loggedIn: isLoggedIn(),
    config: readConfig(),
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
    syncLogPath: SYNC_LOG_PATH,
    notifyQueuePath: NOTIFY_QUEUE_PATH,
    pendingNotifications: readNotificationQueue().length,
    state: readState(),
    statePath: STATE_PATH,
    codexAcp: localCodexAcpCommand(),
  }, null, 2));
} else if (command === "sync") {
  const limit = Number(process.argv[3] || "40");
  console.log(JSON.stringify(readSyncSnapshot(Number.isFinite(limit) ? limit : 40), null, 2));
} else if (command === "notify") {
  const text = process.argv.slice(3).join(" ");
  try {
    const item = enqueueNotification(text);
    console.log(JSON.stringify({
      ok: true,
      queued: item,
      notifyQueuePath: NOTIFY_QUEUE_PATH,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (command === "reset") {
  resetConfig();
} else if (command === "bind") {
  runBind().catch((error) => {
    log(`Fatal: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
} else if (command === "start") {
  runBridge().catch((error) => {
    log(`Fatal: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

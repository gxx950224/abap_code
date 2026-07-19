/* ABAP Code Studio — 前端逻辑（零依赖原生 JS） */
"use strict";

// 关闭网页时通知服务端停止
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon("/api/shutdown");
});

// ============================================================
// 状态
// ============================================================
const state = {
  streaming: false,
  currentAssistantEl: null,   // 流式中的 assistant 气泡内容元素
  toolCards: new Map(),       // toolCallId -> 卡片元素
  es: null,
  historyOpen: false,
  processEl: null,            // 本轮共享过程卡片（details 元素）
  currentThinkSeg: null,      // 当前 assistant 消息绑定的思考段元素（新消息才新建）
};

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// 轻量 Markdown 渲染（代码块纯文本输出，无高亮）
// ============================================================
function renderMarkdown(src) {
  const blocks = [];
  // 用 \x01...\x02 控制符做占位：不会与正常文本冲突，不受 trim 影响
  const stashBlock = (html) => { blocks.push(html); return "\x01" + (blocks.length - 1) + "\x02"; };

  let text = src.replace(/\r\n/g, "\n");

  // 代码块 ```lang\n...```
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    return stashBlock("<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
  });

  // 表格 | a | b |
  text = text.replace(/((?:^\|[^\n]+\|\s*$\n?){2,})/gm, (table) => {
    const rows = table.trim().split("\n").filter((r) => !/^\|[\s:\-|]+\|$/.test(r.trim()));
    const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    let html = "<table>";
    rows.forEach((r, i) => {
      const tag = i === 0 ? "th" : "td";
      html += "<tr>" + cells(r).map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("") + "</tr>";
    });
    return stashBlock(html + "</table>");
  });

  // 标题
  text = text.replace(/^(#{1,4})\s+(.+)$/gm, (m, h, t) => stashBlock(`<h${h.length}>${inlineMd(t)}</h${h.length}>`));

  // 引用
  text = text.replace(/(^&gt; .+(\n|$))+/gm, (q) => {
    const inner = q.split("\n").filter(Boolean).map((l) => l.replace(/^&gt; ?/, "")).join("<br>");
    return stashBlock(`<blockquote>${inner}</blockquote>`);
  });

  // 列表
  text = text.replace(/((?:^[-*] .+\n?)+)/gm, (list) => {
    const items = list.trim().split("\n").map((l) => `<li>${inlineMd(l.replace(/^[-*] /, ""))}</li>`).join("");
    return stashBlock(`<ul>${items}</ul>`);
  });
  text = text.replace(/((?:^\d+[.)] .+\n?)+)/gm, (list) => {
    const items = list.trim().split("\n").map((l) => `<li>${inlineMd(l.replace(/^\d+[.)] /, ""))}</li>`).join("");
    return stashBlock(`<ol>${items}</ol>`);
  });

  // 段落
  text = text.split(/\n{2,}/).map((para) => {
    const t = para.trim();
    if (!t) return "";
    if (/^\x01\d+\x02$/.test(t)) return t;
    return `<p>${inlineMd(t).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");

  // 还原块
  text = text.replace(/\x01(\d+)\x02/g, (m, i) => blocks[+i]);
  return text;

  function inlineMd(s) {
    let r = escapeHtml(s);
    r = r.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
    r = r.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
    r = r.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return r;
  }
}

// ============================================================
// 消息渲染
// ============================================================
// 智能滚动：用户上翻查看历史时不打扰；只有停在底部附近才自动跟随
let autoScroll = true;

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

messagesEl.addEventListener("scroll", () => {
  autoScroll = isNearBottom();
});

function scrollToBottom(force) {
  if (!force && !autoScroll) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserBubble(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = '<div class="meta">你</div><div class="body"></div>';
  el.querySelector(".body").textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom(true);  // 用户发消息时强制跟随
}

function ensureAssistantBubble() {
  if (state.currentAssistantEl) return state.currentAssistantEl;
  const el = document.createElement("div");
  el.className = "msg agent";
  el.innerHTML = '<div class="meta">PI Agent</div><div class="body md"></div>';
  messagesEl.appendChild(el);
  state.currentAssistantEl = el.querySelector(".body");
  return state.currentAssistantEl;
}

// ============================================================
// 过程卡片（一轮提问共享一张：思考段 + 工具调用按时间线交错）
// ============================================================
function ensureProcessCard(beforeEl) {
  if (state.processEl) return state.processEl;
  const det = document.createElement("details");
  det.className = "thinking-block msg-thinking process-card";
  // 默认折叠，点击展开查看思考与工具调用时间线
  det.innerHTML = "<summary>执行过程</summary><div class='process-body'></div>";
  if (beforeEl) {
    messagesEl.insertBefore(det, beforeEl);
  } else {
    messagesEl.appendChild(det);
  }
  state.processEl = det;
  return det;
}

function updateProcessSummary() {
  if (!state.processEl) return;
  const tools = state.processEl.querySelectorAll(".tool-card").length;
  const segs = state.processEl.querySelectorAll(".think-seg").length;
  const parts = [];
  if (segs) parts.push(`${segs} 段思考`);
  if (tools) parts.push(`${tools} 次工具调用`);
  state.processEl.querySelector("summary").textContent =
    "执行过程" + (parts.length ? " · " + parts.join(" · ") : "");
}

function addThinking(text, beforeEl) {
  if (!text) return;
  const card = ensureProcessCard(beforeEl);
  const body = card.querySelector(".process-body");
  // 按消息身份绑定段元素：同一 assistant 消息的 thinking 永远更新同一段，
  // 与工具卡片在 process-body 中的位置无关（修复重复建段 bug）
  if (!state.currentThinkSeg) {
    state.currentThinkSeg = document.createElement("div");
    state.currentThinkSeg.className = "think-seg";
    body.appendChild(state.currentThinkSeg);
  }
  state.currentThinkSeg.textContent = text;
  updateProcessSummary();
  scrollToBottom();
}

function renderAssistantContent(container, contentParts) {
  container.innerHTML = "";
  const bubbleEl = container.closest(".msg");
  for (const part of contentParts || []) {
    if (part.type === "text" && part.text) {
      const div = document.createElement("div");
      div.innerHTML = renderMarkdown(part.text);
      container.appendChild(div);
    } else if (part.type === "thinking" && part.thinking) {
      // 思考收编进过程卡片，不进气泡
      addThinking(part.thinking, bubbleEl);
    } else if (part.type === "toolCall") {
      const card = createToolCard(part.id, part.name, part.arguments);
      // toolCall part 的 arguments 比 start 事件更完整，补全参数显示
      const summary = summarizeArgs(part.arguments);
      if (summary) card.querySelector(".tool-args").textContent = summary;
      // 工具调用收编进过程卡片，保持时间线顺序
      ensureProcessCard(bubbleEl).querySelector(".process-body").appendChild(card);
      updateProcessSummary();
    }
  }
  // 空气泡（只有思考/工具的中间消息）隐藏，文字出现后自动显示
  updateBubbleVisibility(container);
  scrollToBottom();
}

function updateBubbleVisibility(container) {
  const bubble = container.closest(".msg");
  if (!bubble) return;
  const empty = container.children.length === 0 && !container.classList.contains("typing");
  bubble.classList.toggle("empty-bubble", empty);
}

// ============================================================
// 工具调用卡片（幂等：同一 toolCallId 复用同一张卡片）
// ============================================================
const TOOL_ICONS = {
  abap_ping: "⚡", abap_ls: "🔍", abap_cat: "📄", abap_create: "➕",
  abap_put: "💾", abap_check: "✔", abap_activate: "▶", abap_meta: "▦",
  abap_refs: "↗", abap_dump: "⚠", abap_transport: "📦", abap_status: "ℹ",
  abap_message: "✉", abap_texts: "𝐓", abap_system: "⚙", abap_run: "»",
  read: "📖", bash: "$", edit: "✎", write: "✎", grep: "🔍", find: "🔍", ls: "☰",
};

// 工具卡片全部默认折叠，点击头部展开结果

function summarizeArgs(args) {
  if (!args) return "";
  let obj = args;
  if (typeof args === "string") {
    try { obj = JSON.parse(args); } catch { return args.length > 90 ? args.slice(0, 90) + "…" : args; }
  }
  if (typeof obj !== "object" || obj === null) return String(obj).slice(0, 90);
  const keys = Object.keys(obj);
  if (!keys.length) return "";
  const parts = keys.map((k) => {
    let v = obj[k];
    if (typeof v === "string" && v.length > 40) v = v.slice(0, 40) + "…";
    return `${k}: ${JSON.stringify(v)}`;
  });
  const s = parts.join(", ");
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

function createToolCard(id, name, args) {
  // 幂等去重：同一 toolCallId 直接复用已有卡片（避免消息流与事件各建一张）
  if (id && state.toolCards.has(id)) {
    return state.toolCards.get(id);
  }
  const card = document.createElement("div");
  card.className = "tool-card";  // 默认折叠，点击展开查看结果
  card.dataset.toolName = name || "";
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-caret">▸</span>
      <span class="tool-icon">${TOOL_ICONS[name] || "🔧"}</span>
      <span class="tool-name"></span>
      <span class="tool-args"></span>
      <span class="tool-state running"><span class="spinner"></span> 执行中</span>
    </div>
    <div class="tool-body"></div>`;
  card.querySelector(".tool-name").textContent = name || "tool";
  card.querySelector(".tool-args").textContent = summarizeArgs(args);
  card.querySelector(".tool-head").addEventListener("click", () => card.classList.toggle("expanded"));
  if (id) state.toolCards.set(id, card);
  return card;
}

function finishToolCard(id, resultContent, isError) {
  const card = state.toolCards.get(id);
  if (!card) return;
  const stateEl = card.querySelector(".tool-state");
  stateEl.className = "tool-state " + (isError ? "failed" : "done");
  stateEl.textContent = isError ? "✗ 失败" : "✓ 完成";
  const body = card.querySelector(".tool-body");
  let text = "";
  if (Array.isArray(resultContent)) {
    text = resultContent.map((c) => c.text || "").join("\n");
  } else if (typeof resultContent === "string") {
    text = resultContent;
  }
  if (text.length > 8000) text = text.slice(0, 8000) + "\n…（结果过长已截断）";
  body.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "tool-code";
  pre.textContent = text || "(无输出)";
  body.appendChild(pre);
}

// ============================================================
// SSE 事件处理
// ============================================================
function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/events");
  state.es = es;

  // 用微队列处理 SSE 事件，避免阻塞主线程导致点击事件无法响应
  let _sseQueue = [];
  let _sseProcessing = false;
  function _processSseQueue() {
    _sseProcessing = true;
    const batch = _sseQueue;
    _sseQueue = [];
    for (const payload of batch) {
      if (payload.kind === "agent") {
        handleAgentEvent(payload.event);
      } else if (payload.kind === "session_reset") {
        clearChat();
        loadHistory();
        refreshState();
        refreshSessions();
      } else if (payload.kind === "error") {
        addSystemNote("错误：" + payload.error);
        setStreaming(false);
      }
    }
    _sseProcessing = false;
    // 处理期间有新事件进入，继续处理
    if (_sseQueue.length > 0) {
      setTimeout(_processSseQueue, 0);
    }
  }
  
  es.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    _sseQueue.push(payload);
    if (!_sseProcessing) {
      setTimeout(_processSseQueue, 0);
    }
  };

  es.onerror = () => {
    setAgentStatus(false, "连接断开，重连中…");
    es.close();
    setTimeout(connectEvents, 3000);
  };

  es.onopen = () => setAgentStatus(true, "Agent 已连接");
}

function handleAgentEvent(ev) {
  switch (ev.type) {
    case "agent_start":
      setStreaming(true);
      state.currentAssistantEl = null;
      state.processEl = null;             // 新一轮提问 → 新过程卡片
      state.currentThinkSeg = null;
      break;

    case "message_start":
      if (ev.message?.role === "assistant") {
        // 每条新 assistant 消息必须新建气泡——复用旧气泡会把之前的思考块与工具卡片冲掉
        state.currentAssistantEl = null;
        state.currentThinkSeg = null;
        const body = ensureAssistantBubble();
        body.classList.add("typing");
      }
      break;

    case "message_update":
      if (ev.message?.role === "assistant") {
        const body = ensureAssistantBubble();
        renderAssistantContent(body, ev.message.content);
      }
      break;

    case "message_end":
      if (state.currentAssistantEl) {
        state.currentAssistantEl.classList.remove("typing");
        updateBubbleVisibility(state.currentAssistantEl);
      }
      break;

    case "tool_execution_start": {
      if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
      const bubble = state.currentAssistantEl ? state.currentAssistantEl.closest(".msg") : null;
      const proc = ensureProcessCard(bubble);
      proc.querySelector(".process-body").appendChild(createToolCard(ev.toolCallId, ev.toolName, ev.args));
      updateProcessSummary();
      scrollToBottom();
      break;
    }

    case "tool_execution_end":
      finishToolCard(ev.toolCallId, ev.result?.content ?? ev.result, ev.result?.isError ?? ev.isError);
      scrollToBottom();
      break;

    case "agent_abort":
      console.log("[ABAP Studio] 收到 agent_abort 事件");
      addSystemNote("操作已中止");
      if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
      state.currentAssistantEl = null;
      setStreaming(false);
      refreshState();
      break;

    case "agent_end":
      console.log("[ABAP Studio] 收到 agent_end, stopReason:", ev.message?.stopReason);
      if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
      state.currentAssistantEl = null;
      // 本轮无实质内容 → 移除空过程卡片
      if (state.processEl && state.processEl.querySelector(".process-body").children.length === 0) {
        state.processEl.remove();
      }
      setStreaming(false);
      refreshFiles();
      refreshState();
      break;
  }
}

function addSystemNote(text) {
  const el = document.createElement("div");
  el.className = "msg system-note";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function clearChat() {
  messagesEl.innerHTML = "";
  state.currentAssistantEl = null;
  state.toolCards.clear();
  state.processEl = null;
  state.currentThinkSeg = null;
  setStreaming(false);
}

// ============================================================
// 发送 / 停止
// ============================================================
function setStreaming(on) {
  state.streaming = on;
  sendBtn.textContent = on ? "停止" : "发送";
  sendBtn.classList.toggle("stop", on);
  inputEl.disabled = false;
  refreshStateQuick(on);
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  if (state.streaming) {
    console.log("[ABAP Studio] 点击停止, streaming:", state.streaming);
    try {
      await fetch("/api/abort", { method: "POST" });
      console.log("[ABAP Studio] 停止请求完成");
    } catch (e) {
      console.error("[ABAP Studio] 停止请求失败:", e);
    }
    setStreaming(false);
    return;
  }

  addUserBubble(text);
  inputEl.value = "";
  autoGrow();
  setStreaming(true);

  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    addSystemNote("发送失败：" + (j.error || r.status));
    setStreaming(false);
  }
}

// mousedown + sendBeacon：最可靠的停止方式
// sendBeacon 不等待响应，不受主线程阻塞影响
sendBtn.addEventListener("mousedown", (e) => {
  if (state.streaming) {
    e.preventDefault();
    e.stopImmediatePropagation();
    console.log("[ABAP Studio] 停止按钮按下 (mousedown)，发送 abort...");
    navigator.sendBeacon("/api/abort");
    // 不等响应，直接重置 UI
    setStreaming(false);
    addSystemNote("已发送停止请求");
  }
});
sendBtn.addEventListener("click", (e) => {
  if (!state.streaming) sendMessage();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autoGrow);

// ============================================================
// 历史恢复
// ============================================================
async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const j = await r.json();
    if (!j.success) return;
    for (const msg of j.data.messages || []) {
      if (msg.role === "user") {
        const text = (msg.content || []).map((c) => c.text || "").join("");
        if (text) {
          addUserBubble(text);
          state.processEl = null;  // 新用户提问 → 新过程卡片
        }
      } else if (msg.role === "assistant") {
        state.currentThinkSeg = null;
        const body = ensureAssistantBubble();
        renderAssistantContent(body, msg.content);
        state.currentAssistantEl = null;
      } else if (msg.role === "toolResult") {
        finishToolCard(msg.toolCallId, msg.content, msg.isError);
      }
    }
  } catch { /* 忽略 */ }
  scrollToBottom(true);  // 历史加载完成定位到最新
}

// ============================================================
// 对话管理（新建 / 历史 / 切换 / 删除）
// ============================================================
async function newChat() {
  if (state.streaming) {
    addSystemNote("生成中，请先停止再新建对话");
    return;
  }
  const r = await fetch("/api/session/new", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    addSystemNote("新建对话失败：" + (j.error || r.status));
    return;
  }
  // 清空与重载由 SSE session_reset 事件驱动
}

async function switchChat(path) {
  if (state.streaming) {
    addSystemNote("生成中，请先停止再切换对话");
    return;
  }
  const r = await fetch("/api/session/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    addSystemNote("切换对话失败：" + (j.error || r.status));
  }
}

async function deleteChat(path, ev) {
  ev.stopPropagation();
  if (!confirm("确定删除这条历史对话？此操作不可恢复。")) return;
  const r = await fetch("/api/session/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    alert("删除失败：" + (j.error || r.status));
    return;
  }
  refreshSessions();
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return hm;
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}

async function refreshSessions() {
  try {
    const r = await fetch("/api/sessions");
    const j = await r.json();
    if (!j.success) return;
    const list = $("#session-list");
    list.innerHTML = "";
    const sessions = j.data.sessions || [];
    if (!sessions.length) {
      list.innerHTML = '<div class="empty-hint">暂无历史对话</div>';
      return;
    }
    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = "session-item" + (s.current ? " current" : "");
      item.title = s.firstMessage || "(空对话)";

      const text = document.createElement("div");
      text.className = "session-text";
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = s.name || s.firstMessage || "(空对话)";
      const meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = `${formatTime(s.modified)} · ${s.messageCount} 条消息`;
      text.appendChild(title);
      text.appendChild(meta);
      item.appendChild(text);

      if (!s.current) {
        const del = document.createElement("span");
        del.className = "session-del";
        del.textContent = "×";
        del.title = "删除该对话";
        del.addEventListener("click", (ev) => deleteChat(s.path, ev));
        item.appendChild(del);
        item.addEventListener("click", () => switchChat(s.path));
      }
      list.appendChild(item);
    }
  } catch { /* 忽略 */ }
}

$("#new-chat-btn").addEventListener("click", newChat);
$("#history-toggle").addEventListener("click", () => {
  state.historyOpen = !state.historyOpen;
  $("#history-panel").classList.toggle("open", state.historyOpen);
  $("#history-toggle").classList.toggle("open", state.historyOpen);
});

// ============================================================
// 状态面板
// ============================================================
function setAgentStatus(ok, text) {
  $("#agent-dot").className = "dot " + (ok ? "ok" : "err");
  $("#agent-text").textContent = text;
}

function refreshStateQuick(streaming) {
  $("#st-streaming").textContent = streaming ? "生成中…" : "空闲";
}

async function refreshState() {
  try {
    const r = await fetch("/api/state");
    const j = await r.json();
    if (!j.success || !j.data.ready) {
      setAgentStatus(false, "Agent 未就绪");
      return;
    }
    const d = j.data;
    setAgentStatus(true, "Agent 已连接");
    $("#model-info").textContent = d.model || "";
    $("#st-model").textContent = d.model || "-";
    $("#st-thinking").textContent = d.thinkingLevel || "-";
    $("#st-streaming").textContent = d.isStreaming ? "生成中…" : "空闲";
    $("#st-msgcount").textContent = String(d.messageCount ?? 0);
    const sidEl = $("#st-session");
    sidEl.textContent = d.sessionId || "-";
    sidEl.title = d.sessionId ? `点击复制: ${d.sessionId}` : "";
    sidEl.onclick = () => {
      if (!d.sessionId || !navigator.clipboard) return;
      navigator.clipboard.writeText(d.sessionId).then(() => {
        sidEl.classList.add("copied");
        setTimeout(() => sidEl.classList.remove("copied"), 900);
      });
    };
    const toolsEl = $("#st-tools");
    toolsEl.innerHTML = "";
    for (const t of d.tools || []) {
      const chip = document.createElement("span");
      chip.className = "tool-chip";
      chip.textContent = t;
      toolsEl.appendChild(chip);
    }
    if (d.isStreaming !== state.streaming) setStreaming(d.isStreaming);
  } catch {
    setAgentStatus(false, "服务不可达");
  }
}

async function refreshSapStatus() {
  try {
    const r = await fetch("/api/sap-status");
    const j = await r.json();
    if (j.success && j.data) {
      $("#sap-dot").className = "dot ok";
      $("#sap-text").textContent = `SAP ${j.data.sid || "已连接"} · ${j.data.user || ""}`;
    } else {
      $("#sap-dot").className = "dot err";
      $("#sap-text").textContent = "SAP 未连接";
    }
  } catch {
    $("#sap-dot").className = "dot err";
    $("#sap-text").textContent = "SAP 检测失败";
  }
}

// ============================================================
// output 文件列表
// ============================================================
async function refreshFiles() {
  try {
    const r = await fetch("/api/output-files");
    const j = await r.json();
    const list = $("#file-list");
    list.innerHTML = "";
    const files = j.data?.files || [];
    if (!files.length) {
      list.innerHTML = '<div class="empty-hint">暂无文件</div>';
      return;
    }
    for (const f of files) {
      const el = document.createElement("div");
      el.className = "file-item";
      el.title = "点击预览 " + f.name;
      const size = f.size > 1024 ? (f.size / 1024).toFixed(1) + "K" : f.size + "B";
      el.innerHTML = `<span class="fname"></span><span class="fsize">${size}</span>`;
      el.querySelector(".fname").textContent = f.name;
      el.addEventListener("click", () => previewFile(f.name));
      list.appendChild(el);
    }
  } catch { /* 忽略 */ }
}
$("#refresh-files").addEventListener("click", refreshFiles);

// ============================================================
// 文件预览（HTML 浏览器直开，其余弹层预览）
// ============================================================
async function previewFile(name) {
  const url = "/api/output-files/" + encodeURIComponent(name);
  if (/\.html?$/i.test(name)) {
    window.open(url, "_blank");  // HTML 文件交给浏览器渲染
    return;
  }
  const overlay = $("#preview-overlay");
  $("#preview-title").textContent = name;
  $("#preview-download").href = url + "?download=1";
  $("#preview-body").textContent = "加载中…";
  overlay.classList.add("open");
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    $("#preview-body").textContent = text || "(空文件)";
  } catch (e) {
    $("#preview-body").textContent = "加载失败：" + e.message;
  }
}

$("#preview-close").addEventListener("click", () => $("#preview-overlay").classList.remove("open"));
$("#preview-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#preview-overlay").classList.remove("open");
});

// ============================================================
// 快捷指令
// ============================================================
document.querySelectorAll(".cmd-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    const cmd = btn.dataset.cmd || btn.dataset.fill || "";
    inputEl.value = cmd;
    inputEl.focus();
    autoGrow();
  });
});

// ============================================================
// 主题切换
// ============================================================
const THEME_KEY = "abap-studio-theme";
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
}
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});
applyTheme(localStorage.getItem(THEME_KEY) || "dark");

// ============================================================
// 初始化
// ============================================================
connectEvents();
loadHistory();
refreshState();
refreshSapStatus();
refreshFiles();
refreshSessions();
setInterval(refreshState, 5000);
setInterval(refreshSapStatus, 30000);
setInterval(refreshFiles, 15000);
setInterval(refreshSessions, 20000);

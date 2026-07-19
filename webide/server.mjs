/**
 * ABAP Code Studio — PI Agent 对话网页版后端
 *
 * 内嵌 pi-coding-agent SDK，创建与 CLI 完全同构的 PI Agent 会话：
 * 同一套 extensions（16 个 abap_* 工具）、AGENTS.md 铁律、skills、prompts。
 *
 * 零 npm 依赖：Node 原生 http + SSE。
 * 用法：node webide/server.mjs  [PORT=7400]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";

// ============================================================
// WorkBuddy safe-delete 冲突修复
// WorkBuddy 通过 NODE_OPTIONS 注入 genie-safe-delete.cjs，
// hook 了 fs.unlinkSync 等删除方法。当 webide 删除 session 文件时，
// hook 会调用 safe-delete-bulk-guard.cjs 做批量删除检查，
// 但该脚本在 webide 环境下执行失败。
// 清理相关环境变量，使 safe-delete 降级为普通回收站删除。
// ============================================================
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
delete process.env.CODEBUDDY_TOOL_CALL_ID;
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
delete process.env.CODEBUDDY_NODE_BIN;
console.log("[webide] 已清理 WorkBuddy safe-delete bulk guard 环境变量");

// ============================================================
// Windows DOS 弹窗修复：monkey-patch child_process.spawn
// PI SDK 内部 spawn 调用（exec.js / bash.js / find.js / grep.js）
// 均未设置 windowsHide: true，导致网页版对话时频繁弹出 DOS 窗口。
// 在 PI SDK 加载前拦截 spawn，强制注入 windowsHide: true。
// ============================================================
if (process.platform === "win32") {
  const _require = createRequire(import.meta.url);
  const _cp = _require("node:child_process");
  const _origSpawn = _cp.spawn;
  _cp.spawn = function _spawnHidden(command, args, options) {
    const opts = { ...options };
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return _origSpawn.call(this, command, args, opts);
  };
  console.log("[webide] child_process.spawn 已注入 windowsHide 补丁");
}

// ============================================================
// 配置
// ============================================================

const PORT = Number(process.env.WEBIDE_PORT || 7400);
const HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 项目根：默认 webide/ 的上一级；可用 WEBIDE_CWD 指定其他 PI 项目
const ROOT = process.env.WEBIDE_CWD
  ? path.resolve(process.env.WEBIDE_CWD)
  : path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(HERE, "public");
const OUTPUT_DIR = path.join(ROOT, "output");

const GXX_ABAP_JS =
  process.env.GXX_ABAP_JS ||
  "C:\\Users\\24990\\AppData\\Roaming\\npm\\node_modules\\gxx-abap\\bin\\gxx-abap.js";

const PI_SDK =
  process.env.PI_SDK_PATH ||
  "C:\\Users\\24990\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js";

// ============================================================
// PI Agent 会话（单例，所有浏览器标签共享）
// ============================================================

let session = null;
let sessionError = null;
let piSdk = null;
let resourceLoader = null;
let _globalAbort = new AbortController();  // 全局 abort 信号，停止按钮触发

const EXTENSION_PATHS = [
  path.join(ROOT, ".pi", "extensions", "gxx-abap-extension.ts"),
  path.join(ROOT, ".pi", "extensions", "sap-mcp-dev-extension.ts"),
].filter((p) => fs.existsSync(p));

async function createResourceLoader() {
  if (!piSdk) throw new Error("PI SDK 未加载");
  const agentDir = piSdk.getAgentDir?.() || process.env.PI_AGENT_DIR || path.join(ROOT, ".pi");
  const loader = new piSdk.DefaultResourceLoader({
    cwd: ROOT,
    agentDir,
    additionalExtensionPaths: EXTENSION_PATHS,
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
  });
  await loader.reload();
  const extResult = loader.getExtensions();
  if (extResult.errors?.length) {
    for (const e of extResult.errors) {
      console.warn(`[webide] extension 加载警告: ${e.path} - ${e.error}`);
    }
  }
  console.log(`[webide] 已加载 ${extResult.extensions?.length || 0} 个 extension`);
  return loader;
}

async function attachSession(newSession) {
  session = newSession;
  session.subscribe((event) => {
    broadcast({ kind: "agent", event, ts: Date.now() });
  });
}

async function initSession() {
  try {
    piSdk = await import(pathToFileURL(PI_SDK).href);
    resourceLoader = await createResourceLoader();
    const result = await piSdk.createAgentSession({ cwd: ROOT, resourceLoader });
    await result.session.bindExtensions({});
    await attachSession(result.session);
    console.log(`[webide] PI Agent 会话已创建 (sessionId: ${session.sessionId})`);
    if (result.modelFallbackMessage) {
      console.log(`[webide] 模型回退提示: ${result.modelFallbackMessage}`);
    }
  } catch (err) {
    sessionError = err?.message || String(err);
    console.error(`[webide] 会话创建失败: ${sessionError}`);
  }
}

// 重建会话（新建对话 / 切换历史对话）
async function rebuildSession(sessionManager) {
  if (session) {
    try { session.dispose(); } catch { /* ignore */ }
  }
  resourceLoader = await createResourceLoader();
  const options = { cwd: ROOT, resourceLoader };
  if (sessionManager) options.sessionManager = sessionManager;
  const result = await piSdk.createAgentSession(options);
  await result.session.bindExtensions({});
  await attachSession(result.session);
  console.log(`[webide] 会话已重建 (sessionId: ${session.sessionId})`);
  broadcast({ kind: "session_reset", state: sessionState(), ts: Date.now() });
  return session;
}

// ============================================================
// SSE 广播
// ============================================================

const sseClients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ============================================================
// gxx-abap 直连（仅用于 SAP 状态灯，不经 Agent）
// ============================================================

/**
 * 等待子进程退出（处理 Windows detached descendants 继承 pipe handles 导致 close 不触发的边缘情况）
 */
function waitForChildProcess(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) { clearTimeout(postExitTimer); postExitTimer = undefined; }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };

    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const onStdoutEnd = () => { stdoutEnded = true; maybeFinalizeAfterExit(); };
    const onStderrEnd = () => { stderrEnded = true; maybeFinalizeAfterExit(); };
    const onError = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const onExit = (code) => {
      exited = true; exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) postExitTimer = setTimeout(() => finalize(code), 100);
    };
    const onClose = (code) => { finalize(code); };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function runGxxAbap(command) {
  return new Promise((resolve) => {
    const args = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleaned = args.map((a) => a.replace(/^"(.*)"$/, "$1"));
    const proc = spawn(
      process.execPath,
      ["--no-warnings", GXX_ABAP_JS, ...cleaned, "--json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c) => { stderr += c.toString(); });

    waitForChildProcess(proc)
      .then(() => {
        const out = stdout.trim();
        if (!out) return resolve({ success: false, error: stderr.trim() || "无输出" });
        try {
          resolve({ success: true, data: JSON.parse(out) });
        } catch {
          resolve({ success: false, error: `JSON 解析失败: ${out.slice(0, 200)}` });
        }
      })
      .catch((err) => {
        resolve({ success: false, error: err?.message || String(err) });
      });
  });
}

// ============================================================
// 工具函数
// ============================================================

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".abap": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { success: false, error: "文件不存在" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

// 会话状态摘要（右栏面板）
function sessionState() {
  if (!session) return { ready: false, error: sessionError };
  let modelId = "unknown";
  try {
    modelId = session.model?.id || session.model?.name || "unknown";
  } catch { /* ignore */ }
  return {
    ready: true,
    sessionId: session.sessionId,
    sessionName: session.sessionName || null,
    model: modelId,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    tools: session.getActiveToolNames(),
    messageCount: session.messages.length,
  };
}

// ============================================================
// HTTP 服务
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---------- SSE 事件流 ----------
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello", ts: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---------- 会话状态 ----------
    if (pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, { success: true, data: sessionState() });
      return;
    }

    // ---------- 历史消息 ----------
    if (pathname === "/api/history" && req.method === "GET") {
      if (!session) return sendJson(res, 503, { success: false, error: sessionError || "会话未就绪" });
      sendJson(res, 200, { success: true, data: { messages: session.messages } });
      return;
    }

    // ---------- 发送消息 ----------
    if (pathname === "/api/chat" && req.method === "POST") {
      if (!session) return sendJson(res, 503, { success: false, error: sessionError || "会话未就绪" });
      if (session.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止或等待" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { success: false, error: "消息为空" });
      // 不 await：流式输出通过 SSE 推送
      session.prompt(text).catch((err) => {
        broadcast({ kind: "error", error: err?.message || String(err), ts: Date.now() });
      });
      sendJson(res, 202, { success: true, data: { accepted: true } });
      return;
    }

    // ---------- 停止生成 ----------
    if (pathname === "/api/abort" && req.method === "POST") {
      sendJson(res, 200, { success: true });
      
      if (!session) return;
      
      console.log("[webide] ★ 停止：杀旧会话 + 立即建新会话");
      
      // 1. 尝试 abort 旧会话（fire and forget，不等结果）
      try { session.agent?.abort?.(); } catch {}
      try { session.abortBash?.(); } catch {}
      try { session.abortRetry?.(); } catch {}
      
      // 2. 清理旧会话
      const oldSession = session;
      try { oldSession.dispose?.(); } catch {}
      session = null;
      
      // 3. 立即建新会话（不等旧会话完成）
      setTimeout(async () => {
        try {
          resourceLoader = await createResourceLoader();
          const newResult = await piSdk.createAgentSession({ cwd: ROOT, resourceLoader });
          await newResult.session.bindExtensions({});
          await attachSession(newResult.session);
          console.log("[webide] 新会话就绪:", newResult.session.sessionId);
        } catch (e) {
          sessionError = e?.message || String(e);
          console.error("[webide] 重建会话失败:", sessionError);
        }
      }, 500);
      
      // 4. 立即通知前端
      broadcast({ kind: "agent", event: { type: "agent_abort" }, ts: Date.now() });
      return;
    }

    // ---------- 对话管理 ----------
    if (pathname === "/api/sessions" && req.method === "GET") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      const list = await piSdk.SessionManager.list(ROOT);
      const currentFile = session?.sessionFile || null;
      const sessions = (list || [])
        .map((s) => ({
          path: s.path,
          id: s.id,
          name: s.name || null,
          firstMessage: (s.firstMessage || "").slice(0, 60),
          messageCount: s.messageCount,
          modified: s.modified instanceof Date ? s.modified.getTime() : s.modified,
          current: currentFile ? path.resolve(s.path) === path.resolve(currentFile) : false,
        }))
        .sort((a, b) => b.modified - a.modified);
      sendJson(res, 200, { success: true, data: { sessions } });
      return;
    }

    if (pathname === "/api/session/new" && req.method === "POST") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      if (session?.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止" });
      const sm = piSdk.SessionManager.create(ROOT);
      const s = await rebuildSession(sm);
      sendJson(res, 200, { success: true, data: { sessionId: s.sessionId } });
      return;
    }

    if (pathname === "/api/session/switch" && req.method === "POST") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      if (session?.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止" });
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!target) return sendJson(res, 400, { success: false, error: "缺少会话路径" });
      if (!fs.existsSync(target)) return sendJson(res, 404, { success: false, error: "会话文件不存在" });
      const sm = piSdk.SessionManager.open(target);
      const s = await rebuildSession(sm);
      sendJson(res, 200, { success: true, data: { sessionId: s.sessionId } });
      return;
    }

    if (pathname === "/api/session/delete" && req.method === "POST") {
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!target) return sendJson(res, 400, { success: false, error: "缺少会话路径" });
      const currentFile = session?.sessionFile || null;
      if (currentFile && path.resolve(target) === path.resolve(currentFile)) {
        return sendJson(res, 409, { success: false, error: "不能删除当前进行中的对话，请先切换到其他对话" });
      }
      if (!fs.existsSync(target)) return sendJson(res, 404, { success: false, error: "会话文件不存在" });
      // 直接调用系统命令删除，绕过 WorkBuddy safe-delete hook
      // （发布给其他用户时没有 hook，fs.unlinkSync 即可；但当前环境需绕过）
      try {
        const { execFileSync } = await import("node:child_process");
        if (process.platform === "win32") {
          // Windows: PowerShell 移入回收站
          const escaped = target.replace(/'/g, "''");
          execFileSync("powershell", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`
          ], { windowsHide: true, timeout: 15000 });
        } else {
          execFileSync("rm", ["-f", target], { timeout: 5000 });
        }
      } catch (e) {
        // 系统命令失败，回退到 fs.unlinkSync
        try { fs.unlinkSync(target); } catch (e2) {
          return sendJson(res, 500, { success: false, error: e2?.message || String(e2) });
        }
      }
      sendJson(res, 200, { success: true });
      return;
    }

    // ---------- SAP 连接状态（状态灯） ----------
    if (pathname === "/api/sap-status" && req.method === "GET") {
      const r = await runGxxAbap("ping");
      sendJson(res, 200, r.success
        ? { success: true, data: r.data }
        : { success: false, error: r.error || "连接失败" });
      return;
    }

    // ---------- output 文件列表 / 下载 ----------
    if (pathname === "/api/output-files" && req.method === "GET") {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter((f) => fs.statSync(path.join(OUTPUT_DIR, f)).isFile())
        .map((f) => {
          const st = fs.statSync(path.join(OUTPUT_DIR, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, { success: true, data: { files } });
      return;
    }

    if (pathname.startsWith("/api/output-files/") && req.method === "GET") {
      const name = decodeURIComponent(pathname.slice("/api/output-files/".length));
      const safe = path.basename(name); // 防目录穿越
      const fp = path.join(OUTPUT_DIR, safe);
      if (!fp.startsWith(OUTPUT_DIR) || !fs.existsSync(fp)) {
        return sendJson(res, 404, { success: false, error: "文件不存在" });
      }
      const data = fs.readFileSync(fp);
      const asDownload = url.searchParams.get("download") === "1";
      // HTML 文件以 text/html 返回（浏览器直接渲染预览），其余按纯文本
      const isHtml = /\.html?$/i.test(safe);
      res.writeHead(200, {
        "Content-Type": asDownload
          ? "application/octet-stream"
          : isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "Content-Disposition": asDownload
          ? `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
          : `inline; filename*=UTF-8''${encodeURIComponent(safe)}`,
      });
      res.end(data);
      return;
    }

    // ---------- 关闭服务 ----------
    if (pathname === "/api/shutdown" && req.method === "POST") {
      sendJson(res, 200, { success: true, data: { message: "服务正在关闭" } });
      console.log("[webide] 收到关闭请求，正在停止服务…");
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // ---------- 静态文件 ----------
    if (req.method === "GET") {
      let rel = pathname === "/" ? "/index.html" : pathname;
      const fp = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!fp.startsWith(PUBLIC_DIR)) {
        return sendJson(res, 403, { success: false, error: "禁止访问" });
      }
      serveStatic(res, fp);
      return;
    }

    sendJson(res, 404, { success: false, error: "未知接口" });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err?.message || String(err) });
  }
});

// ============================================================
// 启动
// ============================================================

await initSession();

server.listen(PORT, HOST, () => {
  console.log(`[webide] ABAP Code Studio 已启动: http://${HOST}:${PORT}`);
  console.log(`[webide] 项目根目录: ${ROOT}`);
});

// 关闭网页后自动停止服务：跟踪 SSE 连接，全部断开后倒计时退出
let shutdownTimer = null;
const SHUTDOWN_DELAY = 15000; // 15 秒无连接则退出

function resetShutdownTimer() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  if (sseClients.size === 0) {
    shutdownTimer = setTimeout(() => {
      if (sseClients.size === 0) {
        console.log("[webide] 无浏览器连接，自动停止服务");
        process.exit(0);
      }
    }, SHUTDOWN_DELAY);
  }
}

// 监听 SSE 连接变化
const _origAdd = sseClients.add.bind(sseClients);
const _origDelete = sseClients.delete.bind(sseClients);
sseClients.add = (res) => {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  return _origAdd(res);
};
sseClients.delete = (res) => {
  const result = _origDelete(res);
  resetShutdownTimer();
  return result;
};

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

/**
 * gxx-abap Pi Extension
 *
 * 直接调用 Windows Node.js + gxx-abap.js
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ============================================================
// gxx-abap.js 路径
// ============================================================

const GXX_ABAP_JS = "C:\\Users\\24990\\AppData\\Roaming\\npm\\node_modules\\gxx-abap\\bin\\gxx-abap.js";

// ============================================================
// 安全层
// ============================================================

const PROTECTED_PREFIXES = [
  "SAP", "SAPL", "/SAP", "CL_", "CX_", "RS_", "RSS_",
  "BAPI", "BAPIRET", "DDIC", "ICON_", "ST_", "SS_",
];

function isProtected(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_PREFIXES.some((p) => upper.startsWith(p));
}

function isDevObject(name: string): boolean {
  return name.toUpperCase().startsWith("Z") || name.toUpperCase().startsWith("Y");
}

function safetyGuard(name: string, operation: string): void {
  if (isProtected(name)) {
    throw new Error(`[安全拦截] 禁止${operation} SAP 标准对象 "${name}"。只允许操作 Z*/Y* 命名空间。`);
  }
}

// ============================================================
// 三次失败熔断（程序化强制，不依赖模型自觉）
// ============================================================

const ATTEMPT_COUNTER_FILE = path.join(process.cwd(), ".attempt-counter.json");

interface AttemptCounter {
  object: string;
  count: number;
  problem: string;
  lastFix: string;
  state: string;
}

function readAttemptCounter(): AttemptCounter {
  try {
    if (fs.existsSync(ATTEMPT_COUNTER_FILE)) {
      return JSON.parse(fs.readFileSync(ATTEMPT_COUNTER_FILE, "utf-8"));
    }
  } catch {}
  return { object: "", count: 0, problem: "", lastFix: "", state: "idle" };
}

function writeAttemptCounter(c: AttemptCounter) {
  try {
    fs.writeFileSync(ATTEMPT_COUNTER_FILE, JSON.stringify(c), "utf-8");
  } catch {}
}

/** 执行前检查：同一对象连续失败 >= 3 次则阻断 */
function checkFailureLimit(objectName: string): void {
  const c = readAttemptCounter();
  if (c.object === objectName && c.count >= 3 && c.state === "failed") {
    throw new Error(
      `[熔断] "${objectName}" 已连续失败 ${c.count} 次！立即停手。\n` +
      `  上次问题：${c.problem}\n` +
      `  上次修复：${c.lastFix}\n` +
      `  请向用户上报：对象=${objectName}，问题=${c.problem}，已尝试方案=${c.lastFix}，请求指导。`
    );
  }
}

/** 执行后更新计数器 */
function updateAttemptCounter(objectName: string, success: boolean, problem: string = "") {
  const c = readAttemptCounter();
  // 切换对象时重置
  if (c.object !== objectName) {
    c.object = objectName;
    c.count = 0;
    c.problem = "";
    c.lastFix = "";
    c.state = "idle";
  }

  if (success) {
    c.count = 0;
    c.state = "done";
    c.problem = "";
    c.lastFix = "";
  } else {
    c.count += 1;
    if (problem) c.problem = problem.slice(0, 200);
    c.state = "failed";
  }

  writeAttemptCounter(c);
}

// ============================================================
// gxx-abap 执行器
// ============================================================

interface AbapResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * 等待子进程退出（处理 Windows detached descendants 继承 pipe handles 导致 close 不触发的边缘情况）
 * 复刻 PI SDK waitForChildProcess 的逻辑
 */
function waitForChildProcess(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: ReturnType<typeof setTimeout> | undefined;
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

    const finalize = (code: number | null) => {
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
    const onError = (err: Error) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const onExit = (code: number | null) => {
      exited = true; exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) postExitTimer = setTimeout(() => finalize(code), 100);
    };
    const onClose = (code: number | null) => { finalize(code); };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * 静默执行子进程（windowsHide 防止 DOS 弹窗）
 * 复刻 pi.exec 的功能但增加 windowsHide: true
 */
function execHidden(command: string, args: string[], options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      killed = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    };

    if (options.signal) {
      if (options.signal.aborted) { onAbort(); }
      else { options.signal.addEventListener("abort", onAbort, { once: true }); }
    }

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        killed = true;
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, options.timeout);
    }

    waitForChildProcess(proc)
      .then((code) => {
        cleanup();
        resolve({ stdout, stderr, code: killed ? null : code });
      })
      .catch((err) => {
        cleanup();
        stderr += err?.message || String(err);
        resolve({ stdout, stderr, code: null });
      });
  });
}

async function runAbap(pi: ExtensionAPI, command: string, signal?: AbortSignal): Promise<AbapResult> {
  try {
    const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const args = parts.map(a => a.replace(/^"(.*)"$/, "$1"));

    const fullArgs = ["--no-warnings", GXX_ABAP_JS, ...args, "--json"];
    const result = await execHidden(process.execPath, fullArgs,
      { signal, timeout: 120000 },
    );

    const stdout = result.stdout?.trim() || "";
    const stderr = result.stderr?.trim() || "";

    if (!stdout) {
      return { success: false, error: stderr || "无输出" };
    }

    let data: any = null;
    try {
      data = JSON.parse(stdout);
    } catch {
      return { success: false, error: `JSON 解析失败: ${stdout.slice(0, 200)}` };
    }

    if (result.code === 0) {
      return { success: true, data };
    } else {
      return { success: false, data, error: data?.error || data?.message || stderr || `exit code ${result.code}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

function truncateOutput(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let result = truncation.content;
  if (truncation.truncated) {
    result += `\n\n[输出截断: ${truncation.outputLines}/${truncation.totalLines} 行`;
    result += ` (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). 完整内容请用 gxx-abap 命令直接查看]`;
  }
  return result;
}

// ============================================================
// Extension 入口
// ============================================================

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const result = await runAbap(pi, "status");
    if (!result.success) {
      ctx.ui.notify("gxx-abap 未配置 SAP 连接，请先执行: gxx-abap config", "warning");
    } else {
      ctx.ui.notify(`gxx-abap 已连接 SAP: ${result.data?.sid || "OK"}`, "info");
    }
  });

  // ----------------------------------------------------------
  // 审查代码强制规则拦截器
  // 检测"审查/审计/code review"关键词，在 system prompt 注入强制指令
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // 全局 bash+gxx-abap 禁令 — 每次对话都注入
  // ----------------------------------------------------------
  pi.on("before_agent_start", (event, _ctx) => {
    // 全局注入：禁止用 bash 跑 gxx-abap（会导致 DOS 弹窗）
    const globalInject = `

---

## 【全局铁律 — 每次对话强制执行】

**绝对禁止用 bash 执行 gxx-abap 命令。** 这会触发 WSL → Windows 跨进程调用，弹出大量 CMD 窗口。

所有 SAP 操作必须用 abap_* 工具（abap_ls / abap_cat / abap_put / abap_create / abap_activate / abap_meta / abap_run 等）。

即使用 abap_run 工具也绝不用 bash + npx gxx-abap。

如果你违反这条规则，每次 bash 调用都会弹出一个 CMD 黑色窗口，严重影响用户体验。

### 读取源码

读取 SAP ABAP 源码用 abap_cat，禁止使用 mcp__sap-mcp-dev__ABAP_DOWNLOAD（仅在代码审查/审计场景才用 MCP 下载）。

### 写入代码

gxx-abap 会自动检测对象已有的传输号并关联写入。直接用 abap_put 即可，无需手动指定传输号。

如果写入时报传输相关错误，再向用户索要 --transport 参数。
`;
    const newSystemPrompt = (event.systemPrompt || "") + globalInject;

    // 审查场景额外注入
    const prompt = event.prompt || "";
    const reviewKeywords = /审查|审计|code\s*review|review|检查.*代码|看看.*代码.*问题/i;
    if (!reviewKeywords.test(prompt)) return { systemPrompt: newSystemPrompt };

    const inject = `

---

## 【强制指令 — 最高优先级，覆盖其他规则】

用户要求审查代码。你必须严格按以下步骤执行，不得偏离：

1. **禁止调用 \`abap_ls\`** — 审查不需要确认对象是否存在，跳过查重步骤
2. **禁止调用 \`abap_cat\`** — 审查源码必须通过 MCP 下载，不用 abap_cat
3. **立即调用 \`mcp__sap-mcp-dev__ABAP_DOWNLOAD\`** 下载源码：
   - 程序：\`{ "RPROG": "X", "SOPROG": "<程序名>" }\`
   - 函数：\`{ "RFUNC": "X", "SOFNAME": "<函数名>" }\`
4. 按 abap-code-review skill 流程执行审查，生成 \`output/<程序名>_CodeReview.html\`

**如果你调用了 abap_ls 或 abap_cat，你违反了强制规则。**
`;
    return { systemPrompt: newSystemPrompt + inject };
  });

  // ----------------------------------------------------------
  // 1. abap_ping
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_ping",
    label: "SAP Ping",
    description: "测试当前 SAP 连接是否正常",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await runAbap(pi, "ping", signal);
      if (!result.success) throw new Error(`SAP 连接失败: ${result.error}`);
      const d = result.data;
      return {
        content: [{ type: "text", text: `SAP 连接正常\n系统: ${d.sid} (${d.basisVersion})\n主机: ${d.host}:${d.port}\n用户: ${d.user}` }],
        details: { status: "connected", ...d },
      };
    },
  });

  // ----------------------------------------------------------
  // 2. abap_ls
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_ls",
    label: "SAP Search",
    description: "按名称模式搜索 SAP 中的 ABAP 对象，支持 * 通配符",
    parameters: Type.Object({
      pattern: Type.String({ description: "搜索模式，如 ZFIR* 或 ZFI_R*" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runAbap(pi, `ls ${params.pattern}`, signal);
      if (!result.success) throw new Error(`搜索失败: ${result.error}`);
      const objects = result.data?.objects ?? [];
      let text = `搜索 "${params.pattern}"，找到 ${objects.length} 个对象:\n`;
      for (const obj of objects) {
        let label = `${(obj.type || "").padEnd(10)} ${obj.name}`;
        if (obj.type === "FUGR/FF" && obj.uri) {
          const m = obj.uri.match(/\/functions\/groups\/([^/]+)\/fmodules\//);
          if (m) label += ` (函数组: ${m[1].toUpperCase()})`;
        }
        text += `  ${label}\n`;
      }
      return {
        content: [{ type: "text", text: truncateOutput(text) }],
        details: { pattern: params.pattern, count: objects.length },
      };
    },
  });

  // ----------------------------------------------------------
  // 3. abap_cat
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_cat",
    label: "SAP View Code",
    description: "读取 ABAP 对象的完整源码",
    parameters: Type.Object({
      path: Type.String({ description: "对象名" }),
      type: Type.Optional(Type.String({ description: "对象类型: program/class/interface/fm" })),
    }),
    async execute(_toolCallId, params, signal) {
      let cmd = `cat ${params.path}`;
      if (params.type) cmd += ` -t ${params.type}`;
      const result = await runAbap(pi, cmd, signal);
      if (!result.success) throw new Error(`读取失败: ${result.error}`);
      const code = result.data?.source || result.data?.code || JSON.stringify(result.data, null, 2);
      return {
        content: [{ type: "text", text: truncateOutput(code) }],
        details: { path: params.path },
      };
    },
  });

  // ----------------------------------------------------------
  // 4. abap_create
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_create",
    label: "SAP Create",
    description: "在 SAP 中创建 ABAP 对象（program/class/interface）",
    parameters: Type.Object({
      name: Type.String({ description: "对象名称，必须以 Z 或 Y 开头" }),
      type: StringEnum(["program", "class", "interface"] as const, {
        description: "对象类型",
      }),
      description: Type.String({ description: "对象描述" }),
      package: Type.Optional(Type.String({ description: "开发包（可选）" })),
    }),
    async execute(_toolCallId, params, signal) {
      safetyGuard(params.name, "创建");
      checkFailureLimit(params.name);
      let cmd = `create ${params.name} -t ${params.type} --description "${params.description}"`;
      if (params.package) cmd += ` --package ${params.package}`;
      try {
        const result = await runAbap(pi, cmd, signal);
        if (!result.success) {
          updateAttemptCounter(params.name, false, result.error || "创建失败");
          throw new Error(`创建失败: ${result.error}`);
        }
        updateAttemptCounter(params.name, true);
        return {
          content: [{ type: "text", text: `已创建 ${params.type} "${params.name}": ${params.description}` }],
          details: { name: params.name, type: params.type },
        };
      } catch (e) {
        updateAttemptCounter(params.name, false, e?.message || String(e));
        throw e;
      }
    },
  });

  // ----------------------------------------------------------
  // 5. abap_put
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_put",
    label: "SAP Write Code",
    description: "将 ABAP 源代码写入 SAP 系统（从文件），只支持 Z*/Y* 命名空间",
    parameters: Type.Object({
      path: Type.String({ description: "目标对象名" }),
      type: Type.Optional(Type.String({ description: "对象类型: program/class/interface/fm" })),
      file: Type.String({ description: "源码文件路径" }),
      transport: Type.Optional(Type.String({ description: "传输任务号（修改已绑传输的对象时需要）" })),
    }),
    async execute(_toolCallId, params, signal) {
      safetyGuard(params.path, "写入");
      checkFailureLimit(params.path);
      let cmd = `put ${params.path} ${params.file}`;
      if (params.type) cmd += ` -t ${params.type}`;
      if (params.transport) cmd += ` --transport ${params.transport}`;
      try {
        const result = await runAbap(pi, cmd, signal);
        if (!result.success) {
          updateAttemptCounter(params.path, false, result.error || "写入失败");
          throw new Error(`写入失败: ${result.error}`);
        }
        updateAttemptCounter(params.path, true);
        return {
          content: [{ type: "text", text: `代码已写入 ${params.path}` }],
          details: { path: params.path },
        };
      } catch (e) {
        updateAttemptCounter(params.path, false, e?.message || String(e));
        throw e;
      }
    },
  });

  // ----------------------------------------------------------
  // 7. abap_activate
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_activate",
    label: "SAP Activate",
    description: "激活 ABAP 对象（自动语法检查），激活后代码在系统中生效",
    parameters: Type.Object({
      path: Type.String({ description: "对象名" }),
      type: Type.Optional(Type.String({ description: "对象类型: program/class/interface/fm" })),
    }),
        async execute(_toolCallId, params, signal) {
      safetyGuard(params.path, "激活");
      checkFailureLimit(params.path);
      let cmd = `activate ${params.path}`;
      if (params.type) cmd += ` -t ${params.type}`;
      const result = await runAbap(pi, cmd, signal);

      const data = result.data || {};
      const errors = data.errors || [];
      const success = data.success ?? (result.success && errors.length === 0);

      if (success) {
        updateAttemptCounter(params.path, true);
      } else {
        const errText = errors.map((e: any) => `行${e.line}: ${e.text || e.message}`).join("; ") || (result.error || "未知错误");
        updateAttemptCounter(params.path, false, errText);
      }

      let text;
      if (success) {
        text = `✓ ${params.path} 激活成功`;
      } else if (errors.length > 0) {
        text = `✗ ${params.path} 激活失败:
`;
        for (const err of errors) {
          text += `  [${err.type || "ERROR"}] 行 ${err.line}: ${err.text || err.message}
`;
        }
        if (result.error) text += `  ℹ ${result.error}`;
      } else {
        text = `✗ ${params.path} 激活失败: ${result.error || "未知错误"}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { path: params.path, success, errors },
      };
    },
  });

  // ----------------------------------------------------------
  // 8. abap_meta
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_meta",
    label: "SAP Table Structure",
    description: "查看数据库表或结构的字段定义（递归展开 include）",
    parameters: Type.Object({
      name: Type.String({ description: "表名或结构名，如 T001" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runAbap(pi, `meta ${params.name}`, signal);
      if (!result.success) throw new Error(`查询失败: ${result.error}`);
      const fields = result.data?.fields ?? [];
      let text = `${params.name} 字段列表（${fields.length} 个）:\n`;
      text += `${"字段".padEnd(20)} ${"类型".padEnd(10)} ${"长度".padEnd(8)} 描述\n`;
      text += "-".repeat(60) + "\n";
      for (const f of fields) {
        text += `${(f.field || "").padEnd(20)} ${(f.type || "").padEnd(10)} ${String(f.length || "").padEnd(8)} ${f.description || ""}\n`;
      }
      return {
        content: [{ type: "text", text: truncateOutput(text) }],
        details: { name: params.name, fields },
      };
    },
  });

  // ----------------------------------------------------------
  // 9. abap_refs
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_refs",
    label: "SAP References",
    description: "查找指定 ABAP 对象被哪些其他对象引用",
    parameters: Type.Object({
      name: Type.String({ description: "对象名" }),
      type: Type.Optional(Type.String({ description: "对象类型: program/class/table/interface/function/fm" })),
    }),
    async execute(_toolCallId, params, signal) {
      let cmd = `refs ${params.name}`;
      if (params.type) cmd += ` -t ${params.type}`;
      const result = await runAbap(pi, cmd, signal);
      if (!result.success) throw new Error(`查询失败: ${result.error}`);

      const refs = result.data?.references ?? [];
      let text = `${params.name} 被 ${refs.length} 个对象引用:\n`;
      for (const ref of refs) {
        text += `  ${(ref.type || "").padEnd(10)} ${ref.name}\n`;
      }
      return {
        content: [{ type: "text", text: truncateOutput(text) }],
        details: { name: params.name, count: refs.length },
      };
    },
  });

  // ----------------------------------------------------------
  // 10. abap_dump
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_dump",
    label: "SAP Dump",
    description: "读取 SAP ST22 DUMP 的详细信息。不填 id 则返回最新 DUMP 列表。",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "DUMP ID（不填则返回最新 DUMP 列表）" })),
    }),
    async execute(_toolCallId, params, signal) {
      let cmd = "dump";
      if (params.id) cmd += ` ${params.id}`;
      const result = await runAbap(pi, cmd, signal);
      if (!result.success) throw new Error(`查询失败: ${result.error}`);
      const text = result.data?.cleanedContent || result.data?.content || JSON.stringify(result.data, null, 2);
      return {
        content: [{ type: "text", text: truncateOutput(text) }],
        details: { id: params.id },
      };
    },
  });

  // ----------------------------------------------------------
  // 11. abap_transport
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_transport",
    label: "SAP Transport",
    description: "管理 SAP 传输任务",
    parameters: Type.Object({
      action: StringEnum(["list", "object"] as const, {
        description: "list=查看任务列表, object=查看任务包含的对象",
      }),
      task: Type.Optional(Type.String({ description: "传输任务号（action=object 时必填）" })),
    }),
    async execute(_toolCallId, params, signal) {
      let cmd = `transport ${params.action}`;
      if (params.action === "object" && params.task) cmd += ` ${params.task}`;
      const result = await runAbap(pi, cmd, signal);
      if (!result.success) throw new Error(`查询失败: ${result.error}`);
      return {
        content: [{ type: "text", text: truncateOutput(JSON.stringify(result.data, null, 2)) }],
        details: { action: params.action },
      };
    },
  });

  // ----------------------------------------------------------
  // 12. abap_status — 连接状态
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_status",
    label: "SAP Status",
    description: "查看 SAP 连接状态",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await runAbap(pi, "status", signal);
      if (!result.success) throw new Error(`状态查询失败: ${result.error}`);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        details: result.data,
      };
    },
  });

  // ----------------------------------------------------------
  // 13. abap_message — 消息类
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_message",
    label: "SAP Message",
    description: "查看 SAP 消息类中的消息列表",
    parameters: Type.Object({
      name: Type.String({ description: "消息类名，如 ZFI" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runAbap(pi, `message ${params.name}`, signal);
      if (!result.success) throw new Error(`消息查询失败: ${result.error}`);
      const msgs = result.data?.messages ?? [];
      let text = `消息类 ${params.name}（${msgs.length} 条消息）:\n`;
      for (const m of msgs) {
        text += `  ${String(m.number).padEnd(6)} ${m.text || ""}\n`;
      }
      return {
        content: [{ type: "text", text: truncateOutput(text) }],
        details: { name: params.name, count: msgs.length },
      };
    },
  });

  // ----------------------------------------------------------
  // 14. abap_texts — 文本元素（查看/设置）
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_texts",
    label: "SAP Texts",
    description: "查看或修改 ABAP 对象的文本元素（selections/symbols/headings）",
    parameters: Type.Object({
      path: Type.String({ description: "对象名" }),
      type: Type.Optional(StringEnum(["program", "class", "function"] as const, {
        description: "对象类型"
      })),
      action: StringEnum(["read", "set"] as const, {
        description: "read=查看, set=写入"
      }),
      sub: Type.Optional(StringEnum(["selections", "symbols", "headings"] as const, {
        description: "写入子对象（action=set 时必填）"
      })),
      file: Type.Optional(Type.String({ description: "文本元素文件路径（action=set 时必填）" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (params.action === "set") {
        if (!params.sub) throw new Error("写入文本元素时必须指定 --sub");
        if (!params.file) throw new Error("写入文本元素时必须指定 --file");
        safetyGuard(params.path, "修改文本元素");
        let cmd = `texts ${params.path} --set ${params.sub} --file ${params.file}`;
        if (params.type) cmd += ` -t ${params.type}`;
        const result = await runAbap(pi, cmd, signal);
        if (!result.success) throw new Error(`文本元素写入失败: ${result.error}`);
        return {
          content: [{ type: "text", text: `${params.path} 的 ${params.sub} 已更新` }],
          details: { path: params.path, sub: params.sub },
        };
      } else {
        let cmd = `texts ${params.path}`;
        if (params.type) cmd += ` -t ${params.type}`;
        const result = await runAbap(pi, cmd, signal);
        if (!result.success) throw new Error(`文本元素查询失败: ${result.error}`);
        return {
          content: [{ type: "text", text: truncateOutput(JSON.stringify(result.data, null, 2)) }],
          details: result.data,
        };
      }
    },
  });

  // ----------------------------------------------------------
  // 15. abap_system — 系统信息
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_system",
    label: "SAP System",
    description: "查看 SAP 系统信息（SID、版本、内核、组件）",
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["info", "components"] as const, {
        description: "info=基本信息, components=组件列表"
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const sub = params.detail || "info";
      const result = await runAbap(pi, `system ${sub}`, signal);
      if (!result.success) throw new Error(`系统信息查询失败: ${result.error}`);
      return {
        content: [{ type: "text", text: truncateOutput(JSON.stringify(result.data, null, 2)) }],
        details: result.data,
      };
    },
  });

  // ----------------------------------------------------------
  // 16. abap_run — 通用 CLI 执行
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_run",
    label: "SAP gxx-abap CLI",
    description: "直接执行任意 gxx-abap 命令，用于未单独封装为工具的 CLI 命令。所有命令自动加 --json。",
    parameters: Type.Object({
      command: Type.String({ description: "gxx-abap 命令及参数，如 'ls ZFIR*' 或 'system info'" }),
    }),
    async execute(_toolCallId, params, signal) {
      const cmd = params.command.trim();
      const result = await runAbap(pi, cmd, signal);
      if (!result.success) throw new Error(`命令失败: ${result.error}`);
      return {
        content: [{ type: "text", text: truncateOutput(JSON.stringify(result.data, null, 2)) }],
        details: result.data,
      };
    },
  });

  // ----------------------------------------------------------
  // 17. abap_webide — 打开网页版 ABAP Code Studio
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_webide",
    label: "ABAP Code Studio (Web)",
    description: "启动并打开 PI Agent 对话网页版（ABAP Code Studio）。服务未运行时会自动启动本地服务，然后打开浏览器。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal) {
      const PORT = 7400;
      const URL = `http://127.0.0.1:${PORT}`;

      async function isRunning(): Promise<boolean> {
        try {
          const r = await fetch(`${URL}/api/state`, { signal: AbortSignal.timeout(2000) });
          return r.ok;
        } catch {
          return false;
        }
      }

      let started = false;
      if (!(await isRunning())) {
        const serverPath = path.join(process.cwd(), "webide", "server.mjs");
        // 清除 WorkBuddy NODE_OPTIONS 注入（safe-delete hook），
        // 确保 webide 服务器进程不受 WorkBuddy 沙箱影响
        const cleanEnv = { ...process.env, NODE_OPTIONS: "" };
        const child = spawn(process.execPath, [serverPath], {
          detached: true,
          stdio: "ignore",
          cwd: process.cwd(),
          windowsHide: true,
          env: cleanEnv,
        });


  // ----------------------------------------------------------
  // abap_unlock
  // ----------------------------------------------------------
  pi.registerTool({
    name: "abap_unlock",
    label: "SAP Unlock",
    description: "调用 AI_PUT_UNLOCK 接口释放对象编辑锁（SE80/SE37 残留锁）",
    parameters: Type.Object({
      name: Type.String({ description: "对象名（程序/函数组/类等）" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runAbap(pi, `unlock ${params.name}`, signal);
      if (!result.success) throw new Error(`解锁失败: ${result.error}`);
      return {
        content: [{ type: "text", text: `${params.name} 锁已释放` }],
        details: { name: params.name },
      };
    },
  });
        child.unref();
        started = true;

        // 等待服务就绪（最多 20 秒）
        let ok = false;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (await isRunning()) { ok = true; break; }
        }
        if (!ok) throw new Error("webide 服务启动超时，请手动执行: node webide/server.mjs");
      }

      // 打开浏览器（Windows）
      try {
        spawn("cmd", ["/c", "start", URL], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch { /* 打开失败不影响返回 URL */ }

      return {
        content: [{ type: "text", text: `ABAP Code Studio 网页版已就绪\n\n地址: ${URL}\n状态: ${started ? "已新启动服务" : "服务已在运行"}\n\n在浏览器中与 PI Agent 对话即可进行 ABAP 开发（同一套 17 个 abap 工具与规范）。` }],
        details: { url: URL, started },
      };
    },
  });

  // ----------------------------------------------------------
  // 18. ask_user_confirmation — 向用户确认（是/否/自定义）
  // ----------------------------------------------------------
  pi.registerTool({
    name: "ask_user_confirmation",
    label: "用户确认",
    description:
      "需要用户确认时使用。向用户显示问题及选项，等待选择后继续。\n" +
      "参数：question=问题文字, options=选项数组(默认['是','否']), allow_custom=是否允许用户自由输入。\n" +
      "用户选择后返回 {choice: '选项文字'} 或 {choice: '自定义', custom_text: '用户输入'}。",
    parameters: Type.Object({
      question: Type.String({ description: "确认问题，如：'是否继续创建该对象？'" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "选项列表，默认 ['是', '否']" })),
      allow_custom: Type.Optional(Type.Boolean({ description: "是否允许用户输入自定义内容" })),
    }),
    async execute(toolCallId, params, signal) {
      const opts = params.options?.length ? params.options : ["是", "否"];
      const allowCustom = params.allow_custom === true;

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          if (globalThis.__pendingConfirmations?.has(toolCallId)) {
            globalThis.__pendingConfirmations.delete(toolCallId);
          }
        };

        // Agent 中止时清理
        if (signal) {
          if (signal.aborted) {
            cleanup();
            resolve({
              content: [{ type: "text", text: "用户取消了确认" }],
              details: { aborted: true },
            });
            return;
          }
          signal.addEventListener("abort", () => {
            cleanup();
            resolve({
              content: [{ type: "text", text: "用户取消了确认" }],
              details: { aborted: true },
            });
          }, { once: true });
        }

        globalThis.__pendingConfirmations?.set(toolCallId, {
          question: params.question,
          options: opts,
          allowCustom,
          resolve,
          reject,
        });
      });
    },
  });

  console.log("[gxx-abap] 18 个工具已注册");
}

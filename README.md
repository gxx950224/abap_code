# ABAP Code Agent

基于 Pi Agent + gxx-abap CLI 的 SAP ABAP 开发助手。用自然语言驱动 ABAP 报表与函数模块的开发，全程遵守昇兴编码规范。支持 CLI 与**网页版（ABAP Code Studio）**两种使用方式。

## 功能

- 自然语言 → ABAP 报表（Report）
- 自然语言 → ABAP 函数模块（Function Module）
- 网页版对话 IDE：流式对话、工具调用可视化、output 文件管理

## 架构

```
┌─ CLI（pi 命令行）──────────────┐
│                                │
└─ 网页版（ABAP Code Studio）────┤
                                 ▼
                  PI Agent 会话（createAgentSession）
                    自动加载 .pi/ 下的全部资源
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
.pi/extensions/          .pi/prompts/             .pi/skills/
17 个 abap_* 工具        3 个斜杠命令             4 个技能包
        │
        ▼
gxx-abap CLI（ADT REST）→ SAP 开发系统
```

## 设计分层（四大工程范式）

| 范式 | 落地文件 | 职责 |
|------|---------|------|
| 提示词工程 | `.pi/prompts/` | 触发后的门禁流程指令 + 每步输出契约 |
| 上下文工程 | `AGENTS.md` | 常驻核心：铁律、流程纲要、文件路由表；其余内容按需加载 |
| 知识工程 | `SYSTEM.md`、`.pi/skills/`、`Memory.md` | 编码规范唯一权威 + 技能库 + 避坑经验沉淀 |
| 智能体工程 | `.pi/extensions/`、`.attempt-counter.json`、`webide/` | 工具集、安全护栏、三次失败熔断、网页界面 |

> pi v0.74+ 资源发现机制：自动扫描 `.pi/extensions`、`.pi/prompts`、`.pi/skills` 目录；
> 项目根 `AGENTS.md` 自动进入系统提示词；配置读取 `.pi/settings.json`（非 config.json）。

## 项目结构

```
abap_code/
├── AGENTS.md                          # 常驻核心：铁律 + 流程纲要 + 文件路由（自动进系统提示词）
├── SYSTEM.md                          # SAP ABAP 编码规范（昇兴标准，唯一权威）
├── Memory.md                          # 避坑指南（含条目模板）
├── README.md                          # 本文件
├── .attempt-counter.json              # 三次失败熔断计数器
├── output/                            # 生成的本地代码文件（<对象名>.abap）
├── webide/                            # 网页版 ABAP Code Studio
│   ├── server.mjs                     # 后端：PI SDK 会话 + SSE 事件桥 + 静态托管
│   └── public/                        # 前端：index.html / style.css / app.js
└── .pi/
    ├── extensions/
    │   └── gxx-abap-extension.ts      # 17 个 abap_* 工具 + 安全层
    ├── prompts/
    │   ├── abap-report.md             # /abap-report 报表开发流程
    │   ├── abap-function.md           # /abap-function 函数模块开发流程
    │   └── abap-webide.md             # /abap-webide 打开网页版
    └── skills/
        ├── gxx-abap/                  # SAP 工具操作指南（+ CLI 命令参考）
        ├── abap-report/               # 报表代码模板与最佳实践
        ├── abap-function/             # 函数模块代码模板与最佳实践
        └── sap-abap-skills/           # 通用 ABAP 语法库（31 个专题参考）
```

## 前置依赖

```bash
npm install -g gxx-abap @earendil-works/pi-coding-agent
gxx-abap config
gxx-abap ping
```

## 使用方式

### CLI 方式

```bash
cd abap_code
pi
```

### 网页版（ABAP Code Studio）

三种打开方式（任选其一）：

1. CLI 中对 Agent 说：`打开网页 IDE` 或输入 `/abap-webide`
2. 手动启动：`node webide/server.mjs`，浏览器访问 <http://127.0.0.1:7400>
3. 服务已运行时直接访问上述地址（端口可用 `WEBIDE_PORT` 环境变量覆盖）

网页版能力：

- 与 CLI **完全同构**的 PI Agent 会话（同一套 17 个工具、铁律、skills）
- 流式对话、思考过程折叠显示、工具调用卡片（参数/结果可展开）
- 快捷指令、output 文件列表与下载、SAP 连接状态灯、双主题（默认深色）
- 停止生成、刷新恢复历史

### 使用示例

```
你: 帮我写一个销售订单查询报表

Agent:
1. 请你提供程序名（如 ZSDR001）和开发包
2. abap_ls -pattern "ZSDR001"          → 确认不存在
3. abap_meta -name VBAK / VBAP          → 确认表结构
4. 输出逻辑说明                          → 你确认
5. 展示完整代码                          → 你确认
6. abap_create → abap_put → abap_activate
```

## 工具列表

| 工具 | 说明 |
|------|------|
| abap_ping | 测试 SAP 连接 |
| abap_status | 连接状态 |
| abap_ls | 搜索 ABAP 对象 |
| abap_cat | 查看源码 |
| abap_create | 创建对象 |
| abap_put | 写入代码 |
| abap_activate | 激活对象 |
| abap_meta | 查看表结构 |
| abap_refs | 引用查询 |
| abap_dump | DUMP 分析 |
| abap_transport | 传输管理 |
| abap_message | 消息类查询 |
| abap_texts | 文本元素（查/改） |
| abap_system | 系统信息 |
| abap_run | 通用执行（兜底） |
| abap_unlock | 释放对象锁 |
| abap_webide | 启动并打开网页版 ABAP Code Studio |

详细用法见 `.pi/skills/gxx-abap/SKILL.md`。

## 安全防线（双层）

1. **工具层（强制执行）**：Extension 内置安全层，写操作仅允许 `Z*`/`Y*` 命名空间，SAP 标准对象直接拦截报错，无法绕过；网页版服务仅监听 127.0.0.1。
2. **提示层（流程约束）**：`abap_create` / `abap_put` / `abap_activate` 等写操作执行前，必须向用户展示变更概要并获得明确许可；同一问题修复失败 3 次自动熔断上报（`.attempt-counter.json`）。

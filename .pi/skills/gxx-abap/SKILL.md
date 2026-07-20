---
name: gxx-abap
description: 通过 pi 自带的 SAP 工具集（abap_xxx 系列工具）操作 SAP ABAP 开发系统。触发场景：创建/修改/激活/检查 ABAP 对象、搜索对象、查表结构、查引用、查 DUMP、消息类、文本元素、传输请求、系统信息。
category: software-development
agent_created: true
---

# gxx-abap — Harness Engineer 操作指南

通过 pi 已注册的 SAP 工具（`abap_ping` / `abap_ls` / `abap_cat` / `abap_create` / `abap_put` / `abap_activate` / `abap_activate` / `abap_meta` / `abap_refs` / `abap_dump` / `abap_transport` / `abap_status` / `abap_message` / `abap_texts` / `abap_system` / `abap_run`）操作 SAP ABAP 开发系统。

**不要尝试通过 bash 直接运行 `gxx-abap` 命令** — 所有功能已封装为 pi 工具，用工具名调用即可。

## 何时使用本 skill

- 用户要求创建 / 修改 / 激活 / 检查 / 查看 ABAP 对象（程序、类、接口、函数组与函数模块、表、CDS 视图）
- 用户要求搜索对象、查看源码、查表字段与结构、Where-Used 引用、短转储、消息类、文本元素
- 用户要求管理传输请求、查看系统信息、排查程序 DUMP

## 核心规则（必须遵守）

1. **搜索规则** — `abap_ls` 先用精确名搜索（不加通配符）。无结果时向用户确认后再模糊搜索（加 `*`）。创建前用 `abap_ls` 确认对象不存在。
2. **写入源码标准流程** — `abap_ls` 确认 → `abap_create` → 写本地文件 → `abap_put` 写入 SAP → `abap_activate` 激活 → `abap_activate` 验证。
3. **修改已有对象流程** — `abap_cat` 读源码 → 修改本地文件 → `abap_put` 写入 → `abap_activate` 激活。
4. **排查故障用 `abap_dump`** — 程序 DUMP 后调用 `abap_dump` 查详情，定位出错行。
5. **文本元素格式** — selections/headings 无 MaxLength 头，每行 `KEY  =VALUE`（等号前空格补齐对齐）。symbols 首行必须 `@MaxLength:N`，后续 `KEY=VALUE`（单等号）。symbols 只支持更新已存在条目，不能新建。
6. **传输号自动检测** — `abap_put` 会自动查询对象已有的传输号并关联，无需手动指定 `--transport`。仅在自动检测失败时才向用户索要。
7. **查表字段用 `abap_meta` 不用 `abap_cat`** — `abap_meta` 返回结构化字段列表；`abap_cat -t table` 只返回表头定义源码。
8. **涉及修改写入的命令必须向用户确认** — 特别是 `abap_create`、`abap_put`、`abap_texts`（写入模式）、`abap_activate`，执行前展示变更概要并获得明确许可。
9. **通用兜底：用 `abap_run`** — 当没有对应专用工具时（如新命令），用 `abap_run -command "..."` 执行任意 `gxx-abap` 命令。所有命令自动加 `--json`。

## 工具与 CLI 命令对照

| pi 工具 | 作用 | 对应 CLI 命令 |
|---------|------|-------------|
| abap_ping | 测试连接 | `ping` |
| abap_status | 连接状态 | `status` |
| abap_ls | 搜索对象 | `ls <pattern>` |
| abap_cat | 查看源码 | `cat <name>` |
| abap_create | 创建对象 | `create <name> -t <type>` |
| abap_put | 写入代码 | `put <name> <file>` |
| abap_activate | 语法检查 | `check <name>` |
| abap_activate | 激活对象 | `activate <name>` |
| abap_meta | 查表/结构字段 | `meta <name>` |
| abap_refs | Where-Used 引用 | `refs <name>` |
| abap_dump | 查短转储 | `dump [id]` |
| abap_transport | 传输管理 | `transport list/object` |
| abap_message | 查消息类 | `message <类名>` |
| abap_texts | 查/改文本元素 | `texts <name>` |
| abap_system | 系统信息 | `system info/components` |
| abap_run | 通用执行（兜底） | 任意命令 |

> 优先用左侧的专用工具。只有在专用工具无法满足时才用 `abap_run`。

## 标准工作流

> **本地文件约定**：所有本地代码文件统一放 `output/` 目录（`output/<对象名>.abap`），禁止散落项目根目录。

### 新建对象
```
abap_ls -pattern "ZFIR*"           # 确认不存在
abap_create -name ZFIR001 -t program --description "客户余额报表"
# 写本地文件 output/ZFIR001.abap
abap_put -path ZFIR001 -f output/ZFIR001.abap
abap_activate -path ZFIR001
abap_activate -path ZFIR001           # 有错误修正后重试
```

### 修改已有对象
```
abap_cat -path ZFIR001             # 读取源码
# 修改本地文件 output/ZFIR001.abap
abap_put -path ZFIR001 -f output/ZFIR001.abap
abap_activate -path ZFIR001
```

### 查表结构
```
abap_meta -name BKPF               # 查看 BKPF 表字段
```

### 故障排查（程序 DUMP）
```
abap_dump                          # 最新 DUMP 列表
abap_dump -id <14位时间戳>         # 详情，看 termination.line
```

### 文本元素
```
# 查看
abap_texts -path ZFIR001 -action read
# 写入（文件放 output/，命名 <对象名>_texts.txt）
abap_texts -path ZFIR001 -action set -sub selections -file output/ZFIR001_texts.txt
```

### 消息类 & 系统信息
```
abap_message -name ZFI             # 查消息类 ZFI
abap_system                        # 系统基本信息
abap_system -detail components     # 系统组件列表
```

## 确认要求

涉及修改写入的命令（`abap_create`、`abap_put`、`abap_texts` 的 set 模式、`abap_activate`）执行前，必须向用户展示变更概要（对象名、类型、包、传输任务号、改动点），并获得明确许可后再执行。

## 关键业务知识

- 类型映射：`PROG/P`=程序，`CLAS/OC`=类，`INTF/OI`=接口，`FUGR/F`=函数组，`FUGR/FF`=函数模块，`TABL/DT`=表，`DDLS/DF`=CDS 视图
- 自动识别规则：`CL_*`/`ZCL_*`→class，`IF_*`/`ZIF_*`→interface，`SAPL*`/短名→function，其他→program
- `$TMP` 包中的对象不需要传输号
- 文本元素 symbols 只支持更新已存在条目，不能新建

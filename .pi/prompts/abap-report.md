# /abap-report — ABAP 报表开发与修改

## 触发条件
- 用户需要新建一个 ABAP 报表（Report）
- 用户需要修改已有 ABAP 报表的代码

## 前置阅读
- 编码规范：`SYSTEM.md`
- 代码模板与最佳实践：`.pi/skills/abap-report/SKILL.md`
- 工具用法：`.pi/skills/gxx-abap/SKILL.md`

## 工作流程（含确认门禁，⚠ 处必须等用户明确确认）

### 1. 理解需求
- 新建还是修改？程序名是什么？
- 数据来源：查哪几张表？筛选条件？输出字段？
- 排序/分组/汇总需求？

信息不全 → 直接向用户提问，不得自行假设。

### 2. 确认程序名
⚠ 用户确认程序名后才能继续。

### 3. 查重（决定新建/修改路径）
```
abap_ls -pattern "<程序名>"
```
- 不存在 → 走**新建**路径：步骤 4 → 5 → 6 → 7
- 已存在 → 走**修改**路径：步骤 4 → 5 → 6 → 7（跳过 create）

### 4. 确认表结构和现有代码
```
abap_meta -name <表名>                       # 查表结构
abap_cat -path <程序名> -t program           # 修改时读现有源码
```

### 5. 输出逻辑说明（输出契约 A）
按以下格式汇报，⚠ 用户确认后才能写代码：
```
代码逻辑：
1. 选择屏幕：<输入字段>
2. 数据来源：<表 + 关联>
3. 处理逻辑：<汇总/计算/转换>
4. 输出格式：ALV 列表，列包括 <字段清单>
请确认是否有需要修改的地方？
```

### 6. 生成代码并展示
遵循 `SYSTEM.md` 规范生成代码（模板见 `.pi/skills/abap-report/SKILL.md`），写入 `output/<程序名>.abap`，全文展示。
⚠ 用户确认后才能写入 SAP。

### 7. 写入 SAP
新建：
```
abap_create -name <程序名> -t program --description "<描述>" --package <包>
abap_put -path <程序名> -file output/<程序名>.abap
abap_activate -path <程序名>
```
修改：
```
abap_put -path <程序名> -file output/<程序名>.abap
abap_activate -path <程序名>
```
激活报错必须修复，同步更新本地文件。同一问题连续失败 3 次 → 停手上报。

## 输出契约 B（完成后汇报）
```
已完成：
- 程序：<程序名>（<包>）
- 本地文件：output/<程序名>.abap
- 功能：<一句话描述>
- 状态：已激活
```

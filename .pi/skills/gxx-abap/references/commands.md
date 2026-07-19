# gxx-abap 命令完整参考

`gxx-abap` 是 SAP ABAP Development Tools（ADT）CLI，从终端操作 ABAP 开发系统。所有命令均支持 `--json`。下文按类别列出全部命令的参数、示例与返回结构。

## 连接管理

### ping — 测试连接
```bash
gxx-abap ping --json
# 返回: { status, sid, basisVersion, host, port, user }
```

### status — 连接状态
```bash
gxx-abap status --json
```

---

## 对象操作

### ls — 搜索 ABAP 对象
```bash
gxx-abap ls <pattern> --json
gxx-abap ls "Z*" --json
gxx-abap ls "ZPPR090" --json
# 返回: { search, count, objects: [{ name, type }] }
```
`*` 通配符。类型映射：`PROG/P`=程序，`CLAS/OC`=类，`INTF/OI`=接口，`FUGR/F`=函数组，`FUGR/FF`=函数模块，`TABL/DT`=表，`DDLS/DF`=CDS 视图。

### cat — 查看对象源码
```bash
gxx-abap cat <对象名> --json
gxx-abap cat zcl_hello -t class --json
# 返回: { path, type, source }
```
| 参数 | 说明 |
|------|------|
| `<path>` | 对象名 |
| `-t, --type <type>` | `class` `program` `interface` `table` `function` |

**自动识别规则**：`CL_*`/`ZCL_*`→class，`IF_*`/`ZIF_*`→interface，`SAPL*`/短名→function，其他→program。

### create — 创建 ABAP 对象
```bash
gxx-abap create <name> -t <type> --description <desc> --json
gxx-abap create ZCL_TEST -t class --description "测试类" --package ZAI --transport DS4K939701 --json
```
| 参数 | 说明 |
|------|------|
| `<name>` | 对象名，自动转大写 |
| `-t, --type <type>` | **必填**：`class` `program` `interface` `function` |
| `--description` | 描述 |
| `--package` | 包名，默认 `$TMP` |
| `--transport` | 传输**任务号**（非请求号） |

### put — 写入源码（锁定→写入→解锁）
```bash
gxx-abap put <对象名> <文件路径> -t <type> --json
cat code.abap | gxx-abap put ztest -t program --json
# 强制解锁后写入（清除残留锁）
gxx-abap put ztest -t program --force-unlock --json
```
| 参数 | 说明 |
|------|------|
| `<path>` | 对象名 |
| `[file]` | 源码文件，不传从 stdin 读取 |
| `-t, --type <type>` | `class` `program` `interface` `function` |
| `--force-unlock` | 写入前强制解锁 |

写入后在 `finally` 块自动调用 `/sap/bc/zsx_intf_serv/zsx_oa?INTFID=AI_PUT_UNLOCK` 解锁。

### activate — 激活对象（含语法检查）
```bash
gxx-abap activate <对象名> -t <type> --json
# 返回: { success, checkExecuted, activationExecuted, errors: [{ type, line, text }] }
```
`type` 可为 `E`=错误，`W`=警告。激活失败时返回具体行号和消息。

---

## 传输管理

### transport — 管理传输请求
```bash
gxx-abap transport list --json       # 列出当前用户的传输请求
gxx-abap transport object <对象名> --json  # 查看对象关联的传输请求
```

---

## 代码检查

### check — 语法检查
```bash
gxx-abap check <对象名> -t <type> --json
# 返回: { type, path, findings: [{ severity, line, message }], errors, warnings }
```

---

## 对象查询

### meta — 查看表结构/结构字段/数据元素
```bash
gxx-abap meta <名称> --json
# 表/结构返回: { table, fields: [{ field, dataElement, type, length, decimals, description }] }
# 数据元素返回: { name, description, dataType, typeName, length, shortLabel }
```
自动判断表、结构还是数据元素。支持 include 展开。

### refs — Where-Used 引用查询
```bash
gxx-abap refs <对象名> -t <type> --json
# 返回: { object, type, count, references: [{ name, type, description, uri }] }
```

### dump — 短转储查看
```bash
gxx-abap dump --json                                # 列表
gxx-abap dump <14位时间戳ID> --json                  # 详情
gxx-abap dump --from 20250701 --json                 # 按时间过滤
```
详情返回：`{ dumpId, error, exception, program, author, datetime, termination: { uri, line }, chapters, chapterList, content, cleanedContent, sections }`。

---

## 开发辅助

### message — 查看消息类
```bash
gxx-abap message <消息类名> --json
# 返回: { name, count, messages: [{ number, text }] }
```

### texts — 查看/修改文本元素
```bash
# 查看
gxx-abap texts <对象名> -t <type> --json
# 返回: { name, type, selections: [{ key, text }], symbols: [...], headings: [...] }

# 写入
gxx-abap texts <对象名> --set <sub> --file <路径>
echo "KEY  =VALUE" | gxx-abap texts ZTEST --set selections
```
| 参数 | 说明 |
|------|------|
| `-t, --type` | `program` `class` `function` |
| `--set <sub>` | 写入子对象：`selections` `symbols` `headings` |
| `--file` | 文件路径 |
| `--force-unlock` | 写入前强制解锁 |

写入文件格式：每行 KEY =VALUE（KEY 和 = 间用空格补齐对齐）
symbols写入文件格式：首行 `@MaxLength:N`（N=最大文本字节数），后续行 `KEY=VALUE`。

```
@MaxLength:12
001=公司代码
002=公司名称
```

> 注意：symbols 只支持**更新**已存在的文本符号，不支持新建。新建需通过 SE80。

---

## 系统信息

### system — 系统信息
```bash
gxx-abap system info --json             # { sid, basisVersion, kernel, serverName }
gxx-abap system components --json       # { count, components: [{ id, release, patch, ... }] }
```

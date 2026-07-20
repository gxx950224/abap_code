# SYSTEM.md — SAP ABAP 编码规范（昇兴标准）

> 来源：SX_ABAP开发编码规范_V1.0.docx / 命名规范_V1.0.docx

---

## 一、程序结构规范

### 1.1 程序头（Program Header）
每个程序文件必须包含程序头注释：
```abap
*&---------------------------------------------------------------------*
*& Report:  ZFIR001
*& 模块:    FI 财务会计
*& 描述:    客户余额查询报表
*& 作者:    [作者]
*& 日期:    [创建日期]
*&---------------------------------------------------------------------*
* 变更记录:
* 日期       修改人    描述
* 2023-07-20 张三     创建
*&---------------------------------------------------------------------*
```

### 1.2 模块化原则
- 重复调用超过 2 次以上的代码必须封装成 FORM
- FORM 应该被用在逻辑结构（CASE / IF）中
- 使用 PERFORM 而不是重复多条语句来提高可读性

### 1.3 选择屏幕规范
- 参数和选择范围应有默认值或设为必填字段，防止误执行消耗过多资源
- 尽量多使用选择范围增加过滤条件
- 块标题和选择项使用文本元素（Text Elements）
- 所有输入必须进行校验并输出合适的错误信息

---

## 二、命名约定

### 2.1 程序命名
```
Z<模块缩写><开发类型><3位编号>
```
| 位置 | 1 | 2~3 | 4 | 5~7 | 8 |
|------|------|------|------|------|------|
| 内容 | Z | 模块缩写 | 开发类型 | 需求编号 | 子序号(可选) |

模块缩写：
| 模块 | 缩写 |
|------|------|
| 财务会计 | FI |
| 财务控制 | CO |
| 销售分销 | SD |
| 物料管理 | MM |
| 生产计划 | PP |
| 项目管理 | PS |
| 质量管理 | QM |
| 基础系统 | BC |
| 共用功能 | CM |
| 接口应用 | IF |
| 开发相关 | DEV |

开发类型：
| 类型 | 代码 | 说明 |
|------|------|------|
| Report | R | 报表程序 |
| Interface | I | 接口程序 |
| Exit/Module Pool | E | 增强 / 模块池 |
| Data Conversion | C | 批量导入 |
| Form | F | 表单程序 |
| Include | X | Include 程序 |
| Object Type | O | 对象类型 |

示例：`ZFIR001`（FI模块 + 报表 + 001号需求）

### 2.2 复制标准程序
```
ZCOPY_<SAP标准程序名>
```
示例：`ZCOPY_RFITEMAR`

### 2.3 函数组
```
Z<模块缩写>G<3位编号>
```
示例：`ZFIG001`, `ZSDG001`

### 2.4 函数模块
```
Z<模块缩写>_FM_<描述>
Z<模块缩写>_<描述>(接口类RFC: Z<模块缩写>_RFC_<接口编号>_<描述>)
```
示例：`ZFI_FM_GET_OPENITEM`

#### 函数参数命名
| 参数类型 | 前缀 | 示例 |
|---------|------|------|
| IMPORTING（值） | `IV_` | `IV_BUKRS` |
| IMPORTING（结构） | `IS_` | `IS_HEADER` |
| EXPORTING（值） | `EV_` | `EV_MESSAGE` |
| EXPORTING（结构） | `ES_` | `ES_MARA` |
| EXPORTING（内表） | `ET_` | `ET_ITEMS` |
| CHANGING（值） | `CV_` | `CV_COUNT` |
| CHANGING（内表） | `CT_` | `CT_DATA` |
| TABLES | `IT_` 传入 / `ET_` 传出 | `IT_KEYS`, `ET_RESULT` |
| Exception | 全大写描述名 | `MATERIAL_NOT_FOUND` |

### 2.5 类
```
ZCL_<模块缩写>_<描述>
```
示例：`ZCL_FI_BILLING`

### 2.6 接口
```
Z<模块缩写>_IF_<描述>
```
示例：`ZSD_IF_BILLING`

### 2.7 BADI
```
Badí 定义:  Z<模块缩写>_BADI_<描述>
Badí 实施:  Z<模块缩写>_IMPL_<描述>
```
示例：`ZSD_BADI_BILLING`, `ZSD_IMPL_BILLING`

### 2.8 SmartForm / Style
```
SmartForm: Z<模块缩写>_SF_<描述>
Style:     Z<模块缩写>_SY_<描述>
```

### 2.9 数据字典对象
| 对象类型 | 命名格式 | 示例 |
|---------|---------|------|
| 透明表 | `Z<模块缩写>T_<描述>` | `ZFIT_ACC_DOC` |
| 附加结构 | `Z<模块缩写>A_<描述>` | `ZFIA_ACC_ITEM` |
| 结构 | `Z<模块缩写>S_<描述>` | `ZFIS_ACC_ITEM` |
| 数据元素 | `Z<模块缩写>_<描述>` | `ZFI_DOC_TYPE` |
| 域 | `Z<模块缩写>_<描述>` | `ZFI_DOC_TYPE` |
| 视图 | `Z<模块缩写>V_<描述>` | `ZFIV_ACC_OPEN` |
| 表类型 | `Z<模块缩写>TT_<描述>` | `ZFITT_ACC_ITEM` |
| 范围表类型 | `Z<模块缩写>RT_<描述>` | `ZFIRT_BUKRS` |
| 锁对象 | `EZ<模块缩写>T_<描述>` | `EZFIT_ACC_DOC` |
| 检索帮助 | `Z<模块缩写>H_<描述>` | `ZFIH_ACCOUNT` |

### 2.10 事务代码
```
Z<模块缩写><3位数字><可选字母>
```
示例：`ZFI001`, `ZFI002A`, `ZFI002B`

### 2.11 消息类
```
Z<模块缩写>      消息号码范围: 001~999
```

### 2.12 程序内部命名

#### 变量命名
```abap
lv_<描述>    — 局部变量          lt_<描述>    — 局部内表
ls_<描述>    — 局部结构          lo_<描述>    — 对象引用
lr_<描述>    — 数据引用          <fs_<描述>>  — 字段符号
gv_<描述>    — 全局变量          gt_<描述>    — 全局内表
gs_<描述>    — 全局结构          go_<描述>    — 全局对象
```

#### 子程序命名
- FORM 名称以 `F_` 开头：`FORM f_get_data.`, `FORM f_display_alv.`
- 名称应反映功能，使用下划线分隔

#### 模块池/屏幕
- 初始屏幕号：`1000`
- 其他屏幕：以 `10` 或 `100` 递增（`1010`, `1100`, `1200`...）
- 复制标准程序：新增屏幕号 `9000~9999`
- GUI 状态：`GUI_<4位屏幕号>_<版本>`
- GUI 标题：`TITLE_<4位屏幕号>_<版本>`

---

## 三、ABAP 语法规范

### 3.1 通用规则
- 必须使用 PRETTY PRINTER 格式化代码（缩进2个字符）
- 限制一行一个语句关键字，提高可读性
- 不要用 ABAP 关键字作为变量名
- 定义变量优先使用 TYPE 引用数据字典类型或已有类型；允许内联声明（`@DATA(...)`、`VALUE #( )`、`CONV #( )`）等 ABAP 7.40+ 新语法
- 使用 CONSTANTS 定义常量代替硬编码比较值
- 输出消息使用文本元素（Text Elements），支持多语言
- 不要直接删除旧代码，使用块注释代替，再写新代码

### 3.2 数据库访问
- **禁止**使用 Native SQL（EXEC SQL ... END-EXEC）
- 限制使用逻辑数据库（LDB），大量开销影响性能
- 每次数据库操作后必须检查 `sy-subrc`
- SELECT 必须指定字段列表，**禁止 SELECT \***
- 单条数据用 `SELECT SINGLE`
- WHERE 条件字段顺序必须与字典索引定义一致
- 使用 EQ 代替 `=` 比较
- LIKE / NOT / `<>` 性能差，尽量避免

```abap
" ✅ 正确
SELECT SINGLE bukrs, butxt
  FROM t001
  WHERE bukrs = @lv_bukrs
  INTO @DATA(ls_company).

" ❌ 禁止
SELECT * FROM t001 WHERE bukrs = lv_bukrs.
```

### 3.3 FOR ALL ENTRIES
**必须**在 SELECT 前检查内表非空：
```abap
IF lt_keys IS NOT INITIAL.
  SELECT vbeln, posnr, matnr
    FROM vbap
    FOR ALL ENTRIES IN @lt_keys
    WHERE vbeln = @lt_keys-vbeln
    INTO TABLE @DATA(lt_vbap).
ENDIF.
```

### 3.4 JOIN 使用
- 仅允许对最多 **3 张表** 进行 JOIN 操作
- 不能对 CLUSTER 表使用 INNER JOIN

### 3.5 聚合函数
使用 MAX / MIN / SUM / AVG 代替循环取数：
```abap
" ✅ 推荐
SELECT MAX( msgno ) FROM t100 INTO @DATA(lv_max).

" ❌ 不推荐
LOOP AT t100. IF t100-msgno > lv_max. lv_max = t100-msgno. ENDIF. ENDLOOP.
```

### 3.6 内表操作
- READ TABLE 必须带 `WITH KEY`，大表使用 `BINARY SEARCH`
- 二分查找前必须先 `SORT` 内表
- 使用 `SORT <itab> ORDER BY` 代替 `SORT ITAB`
- 使用 REFRESH 清空内容，FREE 释放空间
- LOOP 内不要使用 STOP / CHECK，用 EXIT 跳出

### 3.7 事务处理
- 多个字段更新使用 `SET` 子句提高性能
- 需要逐条错误处理时不使用 SET
- SAP 标准表只能通过标准程序或 BDC 更新

### 3.8 锁对象
- 使用 SAP 锁对象（ENQUEUE / DEQUEUE）控制并发

---

## 四、增强开发规范

### 4.1 BADI 增强
1. SE19 创建 BADI 实施，命名：`Z<模块缩写>_IMPL_<描述>`
2. 在实施类中增加自定义方法：`Z<XX>_<BADI_METH>_<nnn>`
3. 在标准方法中 CALL METHOD 调用自定义方法（逻辑复杂才封装）

### 4.2 CMOD 增强
1. 创建 CMOD 项目
2. 拷贝用户出口函数模块 EXIT_* 为用户函数模块 `Z<XX>_FM_EXIT<描述>`
3. 在拷贝的函数模块中写逻辑
4. Include 程序中仅保留调用该函数的语句

### 4.3 BTE 增强
1. FIBF 创建客户产品：`Z<XX><nnn>`
2. 拷贝 BTE 函数模板到自定义函数模块
3. FIBF 中指定事件 → 产品 → 函数模块

---

## 五、性能优化要点

1. **批量取数**：尽量一次 SELECT 把数据取到内表，避免 SELECT/ENDSELECT 逐条
2. **字段列表**：只取需要的字段，拒绝 SELECT *
3. **WHERE 顺序**：与索引字段顺序一致，先 KEY 后非 KEY
4. **FOR ALL ENTRIES**：必检非空，数据量大时清重（DELETE ADJACENT DUPLICATES）
5. **二分查找**：大表 READ TABLE 必须 BINARY SEARCH
6. **JOIN 限制**：最多 3 表，CLUSTER 表禁止 JOIN
7. **聚合函数**：用 MAX/MIN/SUM/AVG 替代循环
8. **UPDATE**：多字段用 SET 子句
9. **LOCK**：使用标准锁对象 SAP 锁机制

---

## 六、禁止项

- ❌ 禁止 Native SQL（EXEC SQL ... END-EXEC）
- ❌ 禁止 SELECT *
- ❌ 禁止循环内 SELECT SINGLE
- ❌ 禁止 FOR ALL ENTRIES 前不检查非空
- ❌ 禁止 SELECT 全表取数（应用 WITH +DATA 从已有内表取 distinct key 再 JOIN）
- ❌ 禁止修改 SAP 标准对象
- ❌ 禁止 COMMIT WORK 在 BADI/增强中
- ❌ 禁止硬编码断点和测试输出到生产
- ❌ 禁止 ABAP 关键字作为变量名
- ❌ 禁止直接在生产系统开发（不走传输）

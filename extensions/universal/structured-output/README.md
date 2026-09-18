# @zhushanwen/pi-structured-output

结构化输出 pi extension：让模型用经过 JSON Schema 校验的工具调用代替自由文本交付结果。按 `PI_WORKFLOW_SCHEMA` 环境变量装配两种变体——workflow 模式以引擎注入的权威 schema 强制约束产出，日常模式校验模型自报 schema 的数据。

## 两种模式

启动时读取 `PI_WORKFLOW_SCHEMA`（该 env 由 subagent workflow 引擎注入子进程）：

| | workflow 模式（env 有值） | 日常模式（env 无值） |
|---|---|---|
| 工具参数 | 单参数——parameters 即权威 schema 本身 | 双参数 `{schema, data}` 自报形态 |
| 校验权威 | pi 参数层直接按权威 schema 校验模型 arguments，execute 透传不二次校验 | Ajv 校验自报 data（防御链见下） |
| 强制手段 | turn_end 未调用工具 → steer 注入重试（最多 2 次）；同签名校验失败连续 3 次 → 写日志后 abort 当前 turn + shutdown 子进程 + 15s 硬退兜底 | 无（普通工具，失败抛错由模型自修） |

## 提供的工具

### `structured-output`

**workflow 模式**（`PI_WORKFLOW_SCHEMA` 有值时注册）：

- object 根 schema：arguments 即数据本身，如 `structured-output({ score: 8 })`
- 非 object 根 schema（array/string/number/boolean/组合根等）：包装为 `{ value: <data> }`（tool call arguments 协议上必须是 object），错误路径带 `value.` 前缀
- 根级 `additionalProperties` 未声明时注入 `false`：模型多传的字段被参数层显式拒绝（作者显式声明则尊重不动）
- 注册期 fail-fast：非法 schema（非 object/boolean 根、boolean true、无任何关键字的 object）在子进程加载期即终止并指回 workflow 脚本的 schema 定义；schema 超 256KiB 时 stderr 提示精简/拆分（硬拒绝在引擎注入侧）

**日常模式**（交互式 pi 注册）：

- `schema`：JSON Schema draft-07 对象
- `data`：待校验的值（原始类型/object/array 均可）

日常模式防御链（编译前拦截，全部抛错并带回显与纠错提示）：

1. 互换检测——schema 像数据且 data 像 schema → 判定为参数装反，拒绝
2. 无关键字 schema 拒绝——`{}` / `{a:1}` 会被 Ajv（`strict:false`）编译成"接受一切"，静默放行垃圾数据
3. Ajv 编译失败 → 报 Invalid JSON Schema
4. 校验失败 → 报告失败字段路径

## 安装

```bash
# npm 方式（正式）
pi install npm:@zhushanwen/pi-structured-output

# 本地路径加载（开发调试；-e 为 --extension 简写，可多次传入）
pi -e /path/to/extensions/universal/structured-output
pi --extension /path/to/extensions/universal/structured-output
```

## 示例

日常模式（模型自报 schema + data）：

```
structured-output({
  schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
  data: { score: 8 }
})
```

workflow 模式（schema 由引擎注入，模型只提交数据）：

```
structured-output({ score: 8 })            # object 根：arguments 即数据
structured-output({ value: [1, 2, 3] })    # array 根：包装在 value 字段
```

## 文件结构

```
structured-output/
├── index.ts            # 入口 — re-export src/index.ts
└── src/
    ├── index.ts            # 装配分岔：读 PI_WORKFLOW_SCHEMA 选择变体 + re-export
    ├── tool-definition.ts  # 双变体工具定义（workflow 单参数 / 日常双参数）
    ├── execute.ts          # 校验编排（workflow 透传 / 日常防御链）+ 根形态判定
    ├── ajv-validator.ts    # Ajv 编译缓存（WeakMap）
    ├── schema-guards.ts    # 形态守卫纯函数（互换检测 / 关键字识别 / JSON 解析回显）
    ├── workflow-hook.ts    # turn_end 强制调用 hook + RetryState 状态机
    ├── loop-gate.ts        # 同签名失败 ×3 有界闸门（abort + shutdown + 硬退兜底）
    └── text-primitives.ts  # 截断/错误块有界化共享原语
```

## License

MIT

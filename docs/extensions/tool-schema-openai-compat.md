<!-- 决策记录（原实施型设计文档已压缩，全文见 git 历史：`git log --diff-filter=M -- docs/extensions/tool-schema-openai-compat.md`） -->
# Pi Extension Tool Schema OpenAI 兼容性（决策记录）

> **状态**：已实施完毕（2026-08）。规范本体 = [extension-conventions.md](./extension-conventions.md)「Tool 设计」节 [MANDATORY]；机器守卫 = `.githooks/check_tool_schema.py`（pre-commit 拦截顶层非 Object schema）。本文只保留决策结论与取舍理由。

## 结论

`registerTool` 的 `parameters` 序列化后顶层必须是 `type:"object"`；多 action tool 采用「扁平 `Type.Object` + `action` 字段级 `Type.Union`（等价 enum）+ `Static<typeof Schema>` 派生类型 + 运行时分枝校验」范式。违反顶层约束会被严格 OpenAI 兼容网关 400 拒绝整个会话启动（`schema must be a JSON Schema of 'type: "object"', got 'type: null'`）。

## 问题（根因三层）

1. **技术**：`Type.Union([...])` 作顶层 parameters，typebox 序列化产物顶层是裸 `anyOf`、无 `type` 字段，OpenAI function calling 规范不接受（Anthropic 宽松能过，各类 OpenAI 兼容网关严格校验）。
2. **规范**：当时 conventions 的 Tool 设计只有一行「参数用 typebox 定义」，未明确顶层约束与原因，作者用语义最自然的 discriminated union 而不知违规。
3. **防护**：无 precommit 拦截，违规 schema 能一路 commit、发版、到用户环境才暴露。

当时扫描穷尽：仅 goal + todo 两个 tool 中招，其余 extension 的 `Type.Union` 都在字段级（序列化为嵌套 anyOf，合规——scheduler 作为更早注册的 mandatory 从未报错，间接证明字段级嵌套安全）。

## 关键决策与取舍

| 决策 | 选择 | 否决项及理由 |
|---|---|---|
| schema 形态 | 扁平 Object + 字段级 union（scheduler 范式），完全在 xyz-agent extension 源码内闭环 | pi 上游发 provider 前归一化——上游不可控（fork 维护成本 + PR 周期不可控），可控性是决定性因素 |
| 类型层 | `Static<typeof Schema>` 派生全 optional 扁平类型（单一来源） | 手工 discriminated union——类型与 schema 两处同步漂移无兜底；且 todo 双形陷阱检测需跨分支访问 `text`/`texts`，严格 union 下编译报错 |
| 分支语义隔离 | 运行时 handler 按 action 校验必填（错误消息内嵌正确调用示例） | 保留 schema 层隔离——与 OpenAI 规范冲突。取舍代价：`additionalProperties:false` 只挡未声明字段，跨分支声明字段靠 handler 校验（唯一防线，必须有测试覆盖） |
| 防回归 | 静态正则扫描（`= Type.Union` 顶层赋值 vs `action: Type.Union` 字段级冒号，零误报） | 动态序列化（最准但要 build，precommit 体验差） |

## 落地状态

- conventions 规范文案与守卫脚本已上线（对照本文历史附录 A 逐字 apply）
- goal / todo schema 已扁平化，todo 的 `as TodoActionParams` unsafe-cast 已消除（`Static` 派生类型天然替代）
- 无回滚需求：schema 形态变化不影响已持久化 session 数据；发版后观察运行时漏传必填的报错率即可（过高则补强 description 文案，不改 schema 形态）

## 遗留

- **严格网关端到端实测**未在文档销账（字段级嵌套 anyOf 的安全性当时靠 scheduler 间接证据推断）。若某网关连字段级嵌套 anyOf 也拒，plan B：action 字段改 `Type.Enum` / `StringEnum`（序列化为 `enum` 而非 `anyOf`）。
- **pi 上游 suggestion**（并行动作，不阻塞）：建议 pi-mono 提供 `registerMultiActionTool` 一等公民——extension 写 discriminated union，pi 负责合规转换。

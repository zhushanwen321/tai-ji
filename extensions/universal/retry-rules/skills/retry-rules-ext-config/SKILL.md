---
name: retry-rules-ext-config
description: "配置 @zhushanwen/pi-retry-rules（可重试错误规则）或排查「为什么没重试」时加载。含配置文件路径、RetryRulesExtConfig schema（version/customRules/effectiveRules）、规则字段值域（verdict 三态 retryable/non_retryable/conditional、match 双通道 pattern/jsonPath、kind 值域、source 优先序）、长度与条数上限、判定管线两层序、改写标记 [taiji-retry: 识别、热重载时机、默认值、示例、停用通道（pi 原生 retry 配置）。触发词：重试规则、为什么没重试、没触发重试、429 重试、限流重试、retry-rules 配置、retry rules config。"
---

# retry-rules 配置指南

> @zhushanwen/pi-retry-rules：对 `stopReason=error` 的 assistant 消息按重试规则判定，命中 retryable 规则时在 errorMessage 末尾追加 `[taiji-retry:` 标记（追加式，原文完整保留），使错误命中 pi-ai 原生可重试词表，从而触发 pi 原生重试全链路（auto_retry 事件 + 指数退避 + 失败尝试从上下文剔除）。

## 配置文件位置

`<agentDir>/config/retry-rules-ext-config.json`

- `<agentDir>` = pi agent 目录（pi 的 `getAgentDir` 派生，`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；taiji 隔离环境为 `~/.taiji/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- taiji 桌面端由 runtime 启动序列首建该文件（`taiji.startupConfig` 声明）；独立 pi 用户手建同样生效
- 文件缺失 → 空规则集（判定不生效，pi 原生词表兜底），不告警（属正常初始态）；坏 JSON / 字段非法 → 回落默认空规则集并记 extension 告警日志（`<agentDir>/logs/retry-rules-<日期>.log`，同一条损坏文件只告警一次，修正保存后自下一轮判定生效）

## Schema

```ts
interface RetryRulesExtConfig {
  version: 1;                        // 固定为 1
  customRules: RetryableErrorRule[]; // 用户自定义规则段（taiji 设置页编辑写入，source=custom）
  effectiveRules: RetryableErrorRule[]; // 生效规则集（判定管线直读此段）
}
```

- `effectiveRules` = taiji runtime 侧合并视图（编译期基线 ⊕ 远程覆盖 ⊕ 用户自定义）的落盘结果；extension 是纯消费方，独立 pi 用户手编该段同样生效
- 判定只消费 `effectiveRules`；`customRules` 是用户编辑段的持久化形态（runtime 重算合并视图时读取）

## 单条规则字段

```ts
interface RetryableErrorRule {
  id: string;            // ≤64 字符、不含空白，如 zhipu-1302；同文件内不可重复
  name: string;          // ≤120 字符的简短名称
  verdict: "retryable" | "non_retryable" | "conditional"; // 裁决三态（见下）
  match: Match[];        // 匹配条件列表，1-8 条，全部命中才算命中（AND）
  class: string;         // 失败分类（provider/harness/agent/user/engine），必填
  kind?: string;         // 失败细分（可选，值域受 class 约束，见下）；判定管线不消费
  httpStatusClass?: number; // 400-599 整数（可选，纯溯源/展示分组，判定不消费）
  waitHint?: string;     // ≤200 字符等待提示（可选，settings 展示用，判定不消费）
  source: "custom" | "remote" | "builtin"; // 出处（判定排序键，见「判定管线」）
}
```

match 双通道（二选一按 `kind` 字段区分）：

```ts
{ kind: "pattern"; pattern: string }   // 正则通道：对整条 errorMessage 做正则（忽略大小写）
{ kind: "jsonPath"; path: string; operator: "equals" | "contains" | "exists"; value?: string }
// jsonPath 通道：从 errorMessage 提取首个 JSON 平衡片段，按点路径取值后比较
//（openai 兼容层 errorMessage 形如 "429: {json}"，body 内业务码可经 path 提取）
```

校验规则（违反即整份配置回落空规则集并告警，错误文案含修复动作）：

| 字段 | 上限/值域 |
|---|---|
| id | ≤64 字符，不含空白，文件内唯一 |
| name | ≤120 字符，非空 |
| pattern | ≤200 字符；拒绝嵌套量词等高回溯构造（ReDoS 防护）；须是合法正则 |
| jsonPath path | ≤128 字符，不含空白，点路径形态（如 `error.code`、`errors.0.type`） |
| jsonPath operator | equals / contains / exists 三选一；非 exists 时 value 必填（≤256 字符） |
| match 条数 | 1-8 条 |
| 规则条数 | 每段 ≤200 条 |
| httpStatusClass | 400-599 整数 |
| waitHint | ≤200 字符 |
| kind（值域） | provider → `rate_limited` / `protocol_unsupported`；harness → `turn_budget_exhausted` / `timeout`；agent → `no_deliverable`；user → `cancelled`；class=`engine` → 须以 `engine_` 开头（如 `engine_aborted`） |

## 判定管线（两层序，命中即断）

1. **第一层排除**：任一 `verdict=non_retryable` 规则命中 → 不改写（先排除再放行，账户类错误永不误重试，不分 source）
2. **第二层裁决**：按 source 优先序 `custom > remote > builtin` 找首条命中规则——`retryable` → 追加标记触发重试；`conditional` → 不改写（「等不到的人/账户动作」类，恢复指引经轮应答传达）
3. **全未命中** → 不改写，pi 原生词表兜底（`rate.?limit` / `429` / `too many requests` 等仍可触发原生重试）

## 生效时机（判定粒度热重载）

每轮 message_end 判定直读配置（mtime+size 读时刷新），**文件变更自下一轮判定起生效，无需重启**；判定进行中的当轮不受影响。去重：同一条损坏文件版本只告警一次，修正保存（mtime/size 变化）后重读重校。

## 排查「为什么没重试」

| 现象 | 处置 |
|---|---|
| 错误消息带 `[taiji-retry:` 标记但没重试 | 检查 pi 原生「LLM 调用重试」设置（`enabled=false` 或重试次数已耗尽）——原生重试门在词表判定之前检查，标记只是让错误可被判为可重试 |
| 错误消息不带标记且没重试 | 无规则命中且未落 pi 原生词表；确认该错误码事实是否已登记规则（可加 customRules），或错误消息形态与 pattern/jsonPath 通道不匹配 |
| 配置保存后判定不生效 | 查 `<agentDir>/logs/retry-rules-<日期>.log` 告警——校验失败已回落空规则集，按错误文案修正字段值域后保存 |
| 想彻底停用本机制 | 见下「停用通道」 |

## 停用通道

无独立 enabled 开关——停用复用 pi 原生「LLM 调用重试」设置：`enabled=false` 或 `maxRetries=0`。原生重试门位于 errorMessage 词表判定之前，前置门关闭后本扩展的改写不会触发任何重试，自然回落失败如实分类。

## 配置示例

内置基线一条限流规则 + 用户自定义一条 jsonPath 业务码规则：

```json
{
  "version": 1,
  "customRules": [
    {
      "id": "my-provider-1302",
      "name": "某服务商账户限流业务码",
      "verdict": "retryable",
      "class": "provider",
      "kind": "rate_limited",
      "source": "custom",
      "match": [{ "kind": "jsonPath", "path": "error.code", "operator": "equals", "value": "1302" }]
    }
  ],
  "effectiveRules": [
    {
      "id": "openai-429",
      "name": "OpenAI 429 限流",
      "verdict": "retryable",
      "class": "provider",
      "kind": "rate_limited",
      "httpStatusClass": 429,
      "source": "builtin",
      "match": [{ "kind": "pattern", "pattern": "rate limit exceeded" }]
    }
  ]
}
```

默认（startupConfig 首建形态）：`{ "version": 1, "customRules": [], "effectiveRules": [] }`——空规则集 = 判定不生效，pi 原生词表兜底。

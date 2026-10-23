# @zhushanwen/pi-subagent-workflow

Pi 的 subagent + workflow 合并包：任务委派 + 多 agent 编排（chain / parallel / scatter-gather / map-reduce），单包统一执行链 + 分层配额（ADR-030）。

## 工具范围（7 tools）

| 工具 | action 集合 | 关键参数 |
|------|------------|---------|
| `subagent_start` | —（单动作） | `task` + `slug`（≤35 字符）必填，`agent`（.md 绝对路径，缺省 general-purpose）、`model`、`engine`、`fork`、`worktree`、`maxTurns`、`idleTimeoutMs` 等 start 场景可选字段 |
| `subagent_manage` | `list` / `cancel` / `close`（3 个） | `cancel` / `close`：`subagentId` 必填 |
| `subagent_message` | `message` / `fork-from`（2 个） | `message`：`subagentId` + `text` 必填；`fork-from`：`sourceSubagentId` 必填 |
| `subagent_batch` | —（单动作，批量派发，常驻） | `tasks` 必填（成员对象数组，每元素 `{task, agent?, model?, thinkingLevel?}` 为一次派发，全部并行、结果一条通知收尾），可选运行级 `agent` / `model` / `thinkingLevel`（成员缺省值）与 `slug`、`tokens`、`time`；run 级状态控制走 `workflow_control`。形状与示例见「批量派发（`subagent_batch`）」节 |
| `workflow_run` | —（单动作） | `name`（`.js` 绝对路径）+ 可选 `args` / 预算，见「Workflow 生命周期」节 |
| `workflow_control` | `status` / `abort` / `resume`（3 个） | `status`：可选 `runId`（带 = 单 run 成员表视图）；`abort` / `resume`：`runId` 必填，见「Workflow 生命周期」节 |
| `workflow-script` | `generate` / `lint` / `save` / `delete` / `list`（5 个） | `generate`：`script` + `name`（可选 `description`）；`save`：`name`（可 `newName` 改名）；`lint` / `delete`：`name` |

### 批量派发（`subagent_batch`）

`tasks` 是成员对象数组，每个元素一次派发；全部成员并行执行，run 收尾时一条通知带回全部结果：

```json
{
  "tasks": [
    { "task": "读 packages/runtime/src/services，产出模块清单与职责摘要", "agent": "<absolute-path>/explorer.md", "model": "provider/model-a" },
    { "task": "读 docs/testing，产出测试资产清单" }
  ],
  "agent": "<absolute-path>/explorer.md",
  "slug": "inventory-scan"
}
```

- 成员字段：`task` 必填（自包含任务正文，非空白）；`agent`（.md 绝对路径）、`model`（`provider/modelId`）、`thinkingLevel` 为成员级覆盖
- 运行级 `agent` / `model` / `thinkingLevel` 是成员未显式指定时的缺省值，成员级值优先
- `slug`（批次标签）、`tokens` / `time`（整批预算）为整批可选参数

## 工具激活

七个工具分两档：`subagent_start` / `subagent_batch` / `workflow_run` / `workflow-script` 为 direct 常驻——注册不声明 `exposure` 字段（pi SDK 缺省 `direct`），工具声明随会话常驻、对模型默认可见，独立 pi 开箱即用；`subagent_manage` / `subagent_message` / `workflow_control` 为 deferred——不占常驻工具声明，由 pi 内置 `tool_search` 工具检索命中后按需激活，独立 pi 使用需在 `<agentDir>/settings.json`（默认 `~/.pi/agent/settings.json`）加 `"defaultTools": ["+tool_search"]`（`+` 前缀是增量修饰，保留 read/bash/edit/write 默认集），未开启 `tool_search` 时这些工具对模型不可见。

## 内置 Agents

按「读/写 × 视角」正交切分，10 个角色零重叠（C1 起随 `@zhushanwen/subagent-core` 的 `agents/` 资产分发，`<available_subagents>` 的 `<location>` 指向 core 包 `agents/` 内各 agent `.md` 的绝对路径）：

| Agent | 角色 | 读/写 |
|-------|------|-------|
| `explorer` | 代码库侦查：找入口 / 追调用链 / 摸结构 | 只读 |
| `planner` | 复杂任务拆解为有序实施计划（合并需求澄清） | 只读产文档 |
| `coder` | 代码实现、修改、测试（唯一改代码的角色） | 可改 |
| `reviewer` | 代码审查与需求验收（含 git diff） | 只读 |
| `doc-reviewer` | 文档审查（四遍方法论，事实锚点核实；spec / 设计文档） | 只读 |
| `debugger` | 运行时故障诊断，钉根因 | 只读* |
| `analyst` | 深度项目分析，产出给人读的报告 | 只读 |
| `researcher` | 外部资料调研（依赖 tavily skill） | 只读 |
| `orchestrator` | **纯协调器**：拆解 + 委派，不直接执行 | 只协调 |
| `general-purpose` | 兜底，无角色假设 | 按需 |

\* debugger 可加临时诊断日志，但必须诊断后恢复，不改业务代码（修复归 coder）。

日常调用链路：
```
陌生代码改动：  explorer → (planner) → coder → reviewer
修 bug：       debugger 定位 → coder 修复+补测试 → reviewer 验收
新功能开发：    planner → [coder 并行多包] → reviewer 验收
深度调研：      analyst (项目) / researcher (网页)
```

## Orchestrator 协调器模式

orchestrator 是纯协调器角色：拆解任务 → 委派 subagent → 汇总结果，自身不做执行类工作。orchestrator agent 自身也可递归委派子 orchestrator，实现分层任务拆解（深度受 `Depth: N/10` 护栏保护）。

**工具约束（C1/D-5）**：内置模板不携带 `tools:` frontmatter 白名单，subagent 不以 `--tools` 白名单启动——工具约束回归宿主默认工具范围，orchestrator 靠角色职责（职责边界段）约束自身只做协调。想要白名单的用户在 `<workspace>/.agents/agents/` 放同名 `.md` 覆写（发现优先级 project 级最高，稳定遮蔽内置），或临时用 pi CLI 的 `--tools` 白名单验证：

```bash
pi --tools todo,goal_control,workflow_run,subagent_start,ask_user
```

> **依赖**：需先安装本包及相关扩展
> ```bash
> pi install npm:@zhushanwen/pi-subagent-workflow
> pi install npm:@zhushanwen/pi-todo
> pi install npm:@zhushanwen/pi-goal
> ```
> `--tools` 白名单按 tool 注册名匹配。注意 goal 扩展注册的 tool 名是 `goal_control`（非 `goal`）。

### 递归深度

系统内置 `n = 10` 深度护栏（`MAX_FORK_DEPTH`，fork 链与通用嵌套两个计数器共享上限、取严者生效）：fork 链超限抛 `ForkDepthExceededError`，通用嵌套护栏报 `nested_spawn_rejected`。实测建议控制在 **3-4 层**以内——更深层会因上下文逐层压缩导致信息失真。

## Workflow 生命周期

Workflow run 有两类结束形态：**终局**（`done`，outcome 区分 done / failed / cancelled / time_limited——成败已定）与**中断**（`interrupted` 暂停态——执行被打断但可续跑）。`workflow_run` 启动 run；`workflow_control` 共 3 个 action：`status` / `abort` / `resume`。run 的 `name` 仅接受 `.js` 绝对路径（通常是 `<available_workflows>` 条目的 `<location>`；任意声明 `@pi-meta kind:"workflow"` 的绝对 `.js` 路径均可），裸名 / 相对路径拒绝（`not_found`，拒单文案列全部可用条目及 location，按 location 重试即可）。

- **status（状态查询）**：`{"action":"status"}` 列本 session 内存保留窗口内全部 run 摘要；带 `{"action":"status","runId":"<id>"}` 返回该 run 摘要 + 成员表（每个已出现成员一行：state / stepIndex / turns / lastError 等，按 stepIndex 排序；run 行带 `failed N/M` 失败计数，N = failed 成员数 / M = 成员表行数）。带 `runId` 查无此 run 时报错并区分两种情形：id 不存在（核对 id 重试）vs 已终局且超出内存保留窗口（保留窗口由 subagent-core 常量 `MAX_RETAINED_DONE_RUNS` 决定；从该 run 的完成通知恢复结果——省略 `runId` 列全部也查不到它）
- **abort（主动取消）**：`{"action":"abort","runId":"<id>"}`（可选 `"error":"<reason>"`）→ `cancelled` 终局。要新结果就重新 run
- **resume（断点续跑）**：`{"action":"resume","runId":"<id>"}`（可选 args 校验一致性与时间预算）——对 interrupted run 从断点恢复：已完成的调用回放缓存零 token、未完成的按三档恢复（会话完整 → 捞回结果；请求未完成 → 同会话续写；会话不在 → 整跑）；`/workflows resume <id>` 同能力
- **session 切换/关闭时**，所有 running run 转 `interrupted` 暂停态（被打断不记失败）——回原 session 可 resume 续跑
- **持久化 = record 事件流**（`<runId>.record.jsonl`，append-only 单一事实源）：状态由事件流折叠得出；旧 `wf-run-v1`/`wf-run-v2` 快照文件为历史遗留，读侧不消费
- **worker 崩溃自动重建重试**（默认 3 次）：重建时在途 agent 调用被清除重跑，已完成的调用保留 replay 缓存，不重复消耗 token

## 性能：sessions-index.json 持久化索引

冷启动首扫的 identity 探测结论持久化为 `<enc>/sessions-index.json`（`<enc>` = agentDir 下 `subagents/` 内按 cwd 编码的目录段，索引落 sessions 目录同级；stat 戳自校验、tmp(pid+seq)+rename 原子写、60s 节流、损坏/版本不符静默回退全量探测），真实目录（1744 jsonl / 671MB）实测冷扫描中位数 972.8ms → 80.6ms（12.1x，预算 ≤300ms）。可复现验收脚本：`bench/cold-scan.bench.ts`（冷扫描计时 + 输出等价断言）、`bench/concurrent-scan.bench.ts`（3 实例并发 + 随机变异四判定）。

## 从旧版本升级

批量工具 `subagent_batch` 的 `tasks` 从字符串数组改为成员对象数组；旧参数 `agents`（逗号分隔执行者串）与 `aggregate`（结果归约开关）已从工具移除。旧写法对照：

| 旧写法 | 新写法 |
|--------|--------|
| `"tasks": ["任务一", "任务二"]` + `"agents": "<path-a>/explorer.md,<path-b>/explorer.md"` | `"tasks": [{"task": "任务一", "agent": "<path-a>/explorer.md"}, {"task": "任务二", "agent": "<path-b>/explorer.md"}]` |
| `"agents": "<path-a>/explorer.md"`（单值作用于全部成员） | 运行级 `"agent": "<path-a>/explorer.md"` |
| `"aggregate": true`（追加一个归约成员） | 无对应参数：结果照常逐条返回，归约由主 agent 收到完成通知后自行完成 |

旧写法会被拒绝，错误信息即迁移指引：工具调用中出现 `agents` / `aggregate` 时入口直接报错并给出成员对象 / 自行归约的正确形状；`workflow_run` 直调 fan-out 模板的旧 CLI 风格写法 `tasks=["…"]` / `agents="…"` 会在 worker 启动前被类型校验拒绝。已保存的旧脚本按上表改为成员对象写法。

## 安装

```bash
pi install npm:@zhushanwen/pi-subagent-workflow
```

## License

MIT

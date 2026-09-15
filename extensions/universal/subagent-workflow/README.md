# @zhushanwen/pi-subagent-workflow

Pi 的 subagent + workflow 合并包：任务委派 + 多 agent 编排（chain / parallel / scatter-gather / map-reduce），单包统一执行链 + 分层配额（ADR-030）。

## 内置 Agents

按「读/写 × 视角」正交切分，10 个角色零重叠（C1 起随 `@zhushanwen/subagent-core` 的 `agents/` 资产分发，`<available_subagents>` 的 `<location>` 指向 core 包目录）：

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

**工具约束（C1/D-5）**：内置模板不携带 `tools:` frontmatter 白名单，subagent 不以 `--tools` 白名单启动——工具约束回归宿主默认工具面，orchestrator 靠角色职责（职责边界段）约束自身只做协调。想要白名单的用户在 `<workspace>/.agents/agents/` 放同名 `.md` 覆写（project 级源稳定遮蔽内置，是唯一逃生门），或沿用 pi CLI 的 `--tools` 白名单（临时验证）：

```bash
pi --tools todo,goal_control,workflow,subagent,ask_user
```

> **依赖**：需先安装本包及相关扩展
> ```bash
> pi install npm:@zhushanwen/pi-subagent-workflow
> pi install npm:@zhushanwen/pi-todo
> pi install npm:@zhushanwen/pi-goal
> ```
> `--tools` 白名单按 tool 注册名匹配。注意 goal 扩展注册的 tool 名是 `goal_control`（非 `goal`）。

### 递归深度

系统内置 `n = 10` 深度护栏（fork 链 + 嵌套取 max），超过抛 `ForkDepthExceededError`。实测建议控制在 **3-4 层**以内——更深层会因上下文逐层压缩导致信息失真。

## Workflow 生命周期（one-shot）

Workflow run 是一次性执行，状态机两态：`running → done`（`done` 唯一终态，reason 区分 completed / aborted / failed / budget_limited / time_limited）。`workflow` tool 仅 3 个 action：`run` / `status` / `abort`。run 的 `name` 接受 `<available_workflows>` 列出的 workflow 名（内置 chain / parallel / map-reduce / scatter-gather / review-fix-loop 或已保存脚本）或 `.js` 绝对路径。

Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.

- **abort 是唯一的提前停止方式**：`{"action":"abort","runId":"<id>"}`（可选 `"error":"<reason>"`）。不存在 pause/resume action，调用会被 pi schema 校验拒绝（`Validation failed for tool "workflow"`）；`/workflows pause|resume <id>` 返回 removed 提示
- **session 切换/关闭时**，所有 running run 当即作废转 `done,failed`（state.error 为 `Session switched: run terminated` / `Session shutdown: run terminated`），已投入的 token 作废；需要结果就重新 run
- **快照格式 `wf-run-v2`**（status 两态、无 `pausedAt`）；旧 `wf-run-v1` 文件加载时静默跳过
- **worker 崩溃自动重建重试**（默认 3 次）：重建时在飞 agent 调用被清除重跑，已完成的调用保留 replay 缓存，不重复消耗 token

## 性能：sessions-index.json 持久化索引

冷启动首扫的 identity 探测结论持久化为 `<enc>/sessions-index.json`（stat 戳自校验、tmp(pid)+rename 原子写、60s 节流、损坏/版本不符静默回退全量探测），真实目录（1744 jsonl / 671MB）实测冷扫描中位数 972.8ms → 80.6ms（12.1x，预算 ≤300ms）。可复现验收脚本：`bench/cold-scan.bench.ts`（冷扫描计时 + 输出等价断言）、`bench/concurrent-scan.bench.ts`（3 实例并发 + 随机变异四判定）。

## 安装

```bash
pi install npm:@zhushanwen/pi-subagent-workflow
```

## License

MIT

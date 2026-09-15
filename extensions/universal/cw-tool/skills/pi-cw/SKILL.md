---
name: pi-cw
description: "cw 2.0 runner 的 pi 环境实操指南：大型多 agent 并行编码任务用 cw run --spawn pi 全自动调度（designer/developer/独立 reviewer + 机器验证），本 skill 教后台运行、监控、escalation 处置与收尾回流。触发词：递归编排、多 agent 并行开发、大任务拆解、大树拆分。配套 @zhushanwen/pi-cw-tool（cw_query 只读查询工具）。"
---

# pi-cw

cw 2.0 runner 的 pi 环境实操指南（薄封装）。多 agent 并行开发不再需要主 agent 手动编排——`cw run --spawn pi` 一条命令调度到根 unit closed：runner 按 frontier 并行 spawn 无头 pi 进程（designer 写 spec / developer 实现 / 独立 reviewer 审查），每 unit 独立 worktree，机器验证裁决完成。

> **cw 2.0 适配说明**：本 skill 的 1.x 形态（epic→feature→slice→wave 四层递归树 + planning/wave/dev/review/merge 5 个编排 agent + 4 个角色受限 cw_* 工具）已退役——cw 2.0 把编排智能收进引擎，「层主不能自审」由账本层硬保证（review submit 必须 `--role reviewer`）。

**分工边界**：cw 命令面（create / evidence / review / verify 的参数与 gate 规则）、模式分流表、手动流程、spec 格式——以 **cw-cli skill 为唯一权威源**（SSOT），本 skill 不重复，只教 pi 环境的 runner 实操差异。

## 何时用

- 多 unit 编码任务（≥2 unit 或需并行推进）→ 本 skill，走 runner
- 单 unit 任务 / 调试验收命令 / 学习流程 → cw-cli skill 的手动路径
- 纯分析、调研、设计文档（无代码产出）→ 不进 cw

## 流程

### 1. 建 root unit + 任务书

```bash
cw create --id <slug> --brief brief.md
```

任务书（brief）内容原样传给 designer。写拆分建议（哪些子 unit、各自验收方向）能显著减少 spec 返工；cw 2.0 树深度上限 2 层（根 + 叶），需要更深的先人工降层。

### 2. 后台跑 runner

```bash
cw run --root <slug> --spawn pi
```

- `cw run` 前台阻塞直至收束，多 unit 任务常以小时计——**用 bash-async 的 background 模式跑**，不要同步等待
- 并行上限 `--max-concurrency`（默认 3）；reviewer 模型 `--reviewer-model <m>` 或环境变量 `CW_REVIEWER_MODEL`
- developer/designer 模型走环境变量 `CW_AGENT_MODEL`（缺省 `xiaomi-token-plan-cn/mimo-v2.5-pro`）——**不继承当前主 agent 的模型**，与 pi subagent 的模型继承机制无关

### 3. 监控

期间定期用 `cw_query` 工具（本包提供）或 bash 调 `cw` 观察：

- `cw_query action="status"`：各 unit 状态概览；`json=true` 拿结构化投影
- `cw_query action="frontier"`：就绪集合与各维度阻塞情况
- `cw_query action="tree"`：分解树形态；`action="report" rootId=<slug>`：证据链汇总
- escalation 走 stderr——后台形态把 stderr 落盘并定期检查

### 4. escalation 处置

死锁形态 runner 不自动重试，exit 1 收束并在 stderr/转人工清单给出处置指引（阈值与处置表见 cw-cli skill「转人工出口」）。人工处置完成后**重跑 `cw run --root <slug> --spawn pi` 从投影续接**，已完成进展不丢失；Ctrl-C 中断后重跑同理。

### 5. 收尾

根 unit closed 后 runner 输出 worktree 回收清单与 merge 回流指引——按清单把各 unit worktree 的分支回流到 root 分支并清理 worktree。汇报用户以 `cw status` / `cw report` 为准，不信 agent 自报。

## cw_query 工具（本包提供）

只读查询的结构化入口（参数面见工具 description；写命令经 bash 调 `cw`）。适合监控轮询与结果核对；一次性探索用 bash 直接调 cw 亦可。

## 关键约束

- **不手动编排替代 runner** [MANDATORY]：多 unit 任务禁止主 agent 手动逐 unit 派 subagent——角色分工、worktree 隔离、集成 merge、死锁转人工全是 runner 内建机制，手动编排等于全部放弃。
- **账本是唯一真相**：unit 状态以 `cw status` / `cw report` 为准。
- **manual 型验收在 runner 下免机器验证**（自动并入覆盖，无强制人工点）——需要强制人工验收（如 GUI 检查）时，声明 e2e 级 + command 用「检查人工勾选文件」的 gate 脚本，把人工动作变成机器可判的验收前置。

## 标记说明

| 标记 | 含义 |
|------|------|
| `[HISTORICAL]` | 历史经验规则,不允许删除或削弱,只能补充加强 |
| `[MANDATORY]` | 流程强制要求,不遵守会导致编排失败 |

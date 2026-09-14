# goal

Codex 风格的 `/goal` 命令 — 持久目标追踪：`goal_control` 工具创建/完成/阻塞目标，完成需逐条对照 successCriteria 的证据验证，仅 token 维度预算。

## 功能

- **目标管理**：`goal_control` tool 是唯一创建入口（create / complete / report_blocked）。`/goal <objective>` 是提示词触发器——不直接启动，而是引导 AI 调 `goal_control create`（slug / objective / successCriteria 均由 AI 在 toolcall 时决定）
- **证据验证**：complete 必须提供具体 evidence（改动的文件、通过的测试、运行的命令），且满足 create 时定义的每条 successCriteria 条件，不能空口完成
- **预算控制**：仅 token 维度预算（time budget 已移除，耗时仅记账显示）。70% 预警、90% 发收尾 steering、100% 且已发收尾提示后进入 budget_limited 终态。默认不设预算，仅在用户显式要求时设置
- **阻塞处理**：无自动检测——blocked 只能由 agent 主动调 `goal_control report_blocked`（穷尽替代方案后）；用户经 `/goal resume` 恢复（paused/blocked → active）
- **持久化**：状态通过 session entries 保存（append-only），重启后从最新一条 goal-state entry 恢复，崩溃后保持原状态

## 状态机

6 态：`active` / `paused` / `blocked` / `complete` / `budget_limited` / `cancelled`。
`complete` / `budget_limited` / `cancelled` 为终态（不可逆）。

## 安装

```bash
# symlink 方式（开发推荐；globalExtDir 平铺布局，目标不带分组层）
ln -s /path/to/xyz-agent/extensions/universal/goal \
      ~/.pi/agent/extensions/goal

# npm 方式（正式）
pi install npm:@zhushanwen/pi-goal
```

## 使用

```
/goal 修复项目中所有失败的测试
/goal 实现用户认证功能 --tokens 500000
/goal status      # 查看进度（criteria 逐条编号显示）
/goal resume      # 恢复（paused/blocked → active）
/goal pause       # 暂停（active → paused）
/goal update <new-objective> [--criteria <a;b;c>]   # 重塑目标
/goal history     # 查看历史 goal
/goal clear       # 清除（→ cancelled）
```

## 文件结构

```
goal/
├── index.ts            # 入口 — re-export src/index.ts
└── src/
    ├── index.ts        # 工厂入口（注册 command/tool/events + goalInit slot，全部委托 adapters）
    ├── commands.ts     # /goal 命令参数解析（仅识别 --tokens flag）
    ├── constants.ts    # 语义常量
    ├── ports.ts        # Pi 能力抽象（Persistence/Ui/Messaging/Session）
    ├── service.ts      # 协调层 — createGoal / finalizeAndPersist / applyEvent
    ├── persistence.ts  # serialize/deserialize + GoalHistoryEntry
    ├── session.ts      # 运行时句柄 + 状态重建（append-only 只读最新一条，无 entry GC）
    ├── engine/         # 零 Pi 依赖的纯状态机（goal/budget/types/liveness）
    ├── adapters/       # Pi 桥接（goal-control-adapter / command-adapter / ports /
    │                   #   success-criteria + event-handlers/）
    └── projection/     # 渲染（widget / prompts / gui）
```

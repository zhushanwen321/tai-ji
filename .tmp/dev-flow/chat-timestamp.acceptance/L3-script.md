# chat-flow-timestamp · L3 剧本（预编译稿，阶段 5 执行）

> 分流结论：**全部 L3 可脚本化，无 L4**——形态断言全部可机器判定（testid/文本/数值变化），视觉观感已由 demo + 用户拍板 + 单测 DOM 断言覆盖。
> 一次性 vs 可复用：**一次性**（live 场景依赖真实 LLM turn + dev 实例数据目录，沉淀为可复用 spec 成本>收益；历史渲染部分若未来需要回归再升格）。执行后 impl-plan 变更历史记一笔。

## 环境准备（共享，一次）

1. `XYZ_DEV_BACKGROUND=1 pnpm dev`（worktree 装配器，showInactive 不抢焦点）
2. `node apps/electron/scripts/dev-instance.mjs --print` → 取本实例 CDP 端口（browser-automation 连 `http://localhost:<cdp-port>`；确认 list-pages URL 是本实例 vite 端口，防连错）
3. 历史场景 fixture：向 dev 实例数据目录 `~/.xyz-agent-dev/instances/feat-chat-flow-timestamp/` 下 sessions 注入合成 pi session JSONL（entry 格式对齐 packages/shared/src/pi-entry.ts：assistant entry content 含 toolCall + 独立 toolResult entry，body.timestamp 给固定毫秒值如 1000/5432，ISO 顶层 timestamp 对应）→ 重启实例 → SessionScanner 扫出。注入目标是 `~/.xyz-agent-dev`（fs-guard 白名单语义内），非真实 `~/.xyz-agent`。

## 场景表（核心先行 + 依赖）

| # | 组 | 依赖 | 操作 | 机器断言 | 抓取 |
|---|----|------|------|----------|------|
| S1 | 核心 | 环境准备 | 打开注入的历史 session，展开目标 turn trace | ① tool 块 header 内存在 `X.Xs · HH:MM:SS` 槽（新 testid，与 U2 实现对齐后回填此处）；② 耗时数值 =（toolResult.ts − assistant.ts）/1000 秒（fixture 固定值 4.4s→显示 4.4s，容差 ±0.1）；③ 时刻 = fixture assistant.ts 的本地 HH:MM:SS | 全页截图 + console + 断言日志 |
| S2 | 核心 | S1 | 同一 turn：text/thinking 块行尾槽存在 | text 块行尾 = assistant message.ts 本地时刻；thinking 块行尾同 | 同上 |
| S3 | 核心 | S1 | 同一 turn：TurnMeta 行 | 区间文本 `· HH:MM:SS → HH:MM:SS` 存在，首值 = fixture 首 assistant.ts、末值 = 末 assistant.ts（本地时区） | 同上 |
| S4 | 核心 | S1 | 重开 session（切走再切回，或重开实例）→ 重新展开 | S1/S2/S3 全部断言复验通过（**reload 持久 = endTime 回填生效的核心证据**，A5） | 同上 |
| S5 | 核心 | 环境 | 新发一条消息（默认模型 mimo-v2.5-pro），等待 assistant 回复完成 | ① streaming 期间 TurnMeta 区间末侧显示「进行中」i18n 文案；② 完成后区间定格为真实首末时刻；③ 若产生 tool 调用：running 期间耗时数值两次采样递增（live tick），完成后 `耗时 · 时刻` 出现 | 同上 |
| S6 | 非核心 | S5 | user 气泡 | 气泡行尾时刻 = 发送时刻本地 HH:MM:SS；编辑态进入时时刻槽消失 | 同上 |

## 依赖与互斥

- S1-S4 串行同实例（共享 fixture session）；S5-S6 依赖环境但独立于 fixture，可在第二实例并行（无装配器冲突：装配器按 worktree 名 hash 派生端口，单 worktree 单实例——S5/S6 与 S1-S4 同实例串行即可，本流水线场景量小不做多实例）
- 核心短路：S1 或 S4 fail → S5/S6 挂起，先进修复循环

## 汇总判定

全部产物（截图/console/断言日志）交由主 agent 逐条核对（场景量 ≤6，不派汇总 subagent——成本低于一轮派发）；fail 归因到场景与日志行。

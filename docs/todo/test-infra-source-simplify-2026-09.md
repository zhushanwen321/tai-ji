# 测试体系审计·源码简化候选（2026-09）

> 来源：2026-09-14 CI/测试耗时专项的三份审计（renderer 价值审计 / runtime 价值审计 / runtime top10 慢因深挖），完整数据链见会话记录与本文件 §2 证据。
>
> **⛔ 实施状态：未排期（用户指令：留档）**。本文件只登记候选与证据，不含波次归属；重新评估触发：CI 分片改造（已落地）跑稳后按测试墙钟数据复核，或对应模块下次重构顺路消化。
>
> 前置关联：runtime 测试耗时的头号根因（fakeProc 永不发 exit → kill 走满 2s grace + `STARTUP_DELAY_MS=500` 真睡）由独立小改造修复（`test/helpers/rpc-client-mock.ts` + `RpcClient` 参数注入），**不在本文件范围**；本文件只收「源码本体简化」。

## §1 候选清单

### R1. PanelContainer retryFn 路由收敛（renderer）

- **位置**：`packages/renderer/src/components/workspace/PanelContainer.vue:221-248`
- **现状**：模块级 `let retryFn`（tab 间共享单槽）+ provide 内 if/else 按 tab 路由重试
- **证据（bug 形态同源）**：W31 major-2「terminal 永久卡死」即此形态的实锤事故；现有 3 个专门回归文件（`panel-container-lazy-retry / -detail / PanelContainer.test.ts`，合计 5.9s）钉扎该行为
- **方向**：收敛为 `Map<tabId, retryFn>`，或抽通用 `<AsyncBoundary>` 组件承接「加载失败 → 重试」语义
- **连带收益**：3 个回归文件可合并为 1 个参数化文件（注意：`panel-container-lazy-retry{,-detail}` 现因 vi.mock 成功结果跨用例缓存而**技术性强制分文件**，重构消除该约束后方可合并）

### R2. fileTree projection 下沉 core 纯函数（renderer）

- **位置**：`packages/renderer/src/stores/fileTree.ts`（521L，renderer 最大 store）
- **现状**：projection 逻辑与 Pinia store 共居，`fileTree-projection.test.ts` 等价性用例 ×24 为测纯函数性质却要付 happy-dom 组件环境开销
- **方向**：projection 下沉 `packages/core`（或 renderer 内独立纯函数模块），测试脱离组件环境
- **收益**：24 用例省 environment 开销；store 本体瘦身

### R3. 观察项（不动）：useChat.ts 1339L 单 factory

- 依赖面宽但 chat 域绞杀已完成（`stores/chat.ts` 36 行薄包装，主体在 core），暂无进一步拆分必要性；下次 chat 域重构时顺路复核

### T1. rpc-client 薄 wrapper 表驱动化（runtime）

- **位置**：`packages/runtime/src/infra/pi/rpc-client.ts:785-943`
- **现状**：约 20 个「构造 `{type, params}` → sendCommand → 解包」的同构命令方法
- **方向**：表驱动（command → {type, params} 元数据 + 单个泛型 sender）
- **连带收益**：低价值透传测试家族（streaming-behavior 6t / system-prompt 3t / preset-args 8t 逐 flag 重复锁同一透传契约）可表驱动化归并

### T2. start() 抽 spawnHarness（runtime）

- **位置**：`packages/runtime/src/infra/pi/rpc-client.ts:272-575`
- **现状**：start() 内联 spawn + stderr ring + crash log 收口，300 行单函数
- **方向**：抽 `spawnHarness`（spawn / 崩溃日志 / 启动确认三段），测试可单测 harness
- **风险**：启动链是事故高发区（early-frame-buffer、spawn-markers 落盘均在链上），重构须带等价性测试

### T3. 测试骨架收敛：test/helpers/pi-spawn-stub.ts（runtime，测试基建）

- **现状**：4 份同构 fakeProc 骨架（`rpc-client-spawn-args.test.ts:12` 自注「同构骨架」；已收敛先例 `test/helpers/free-port.ts`、`test/helpers/rpc-client-mock.ts`）
- **方向**：未走共享 helper 的 4 份骨架并入 `rpc-client-mock.ts`（或其继任者），与 #1 时间常量治理同文件落地
- **备注**：此项与 R 类不同，属于纯测试基建，成本低，可在下次触碰 rpc-client 测试时顺路做

## §2 证据锚点（2026-09-14 实测）

| 项 | 关键证据 |
|----|---------|
| R1 | `PanelContainer.vue:221-248` 模块级 `let retryFn`；W31 major-2 事故；`panel-container-lazy-retry.test.ts:14-17` 头注（mock 缓存强制分文件） |
| R2 | `stores/fileTree.ts` 521L；`fileTree-projection.test.ts` 24 例纯函数测试跑在组件环境 |
| T1 | `rpc-client.ts:785-943` 20 个同构 wrapper；透传测试家族重复（streaming-behavior/system-prompt/preset-args） |
| T2 | `rpc-client.ts:272-575` start() 单函数 300 行 |
| T3 | `rpc-client-spawn-args.test.ts:12`「同构骨架」自注；4 份骨架 × ~60 行 |

> 复核提醒：实施前先重跑 `docs/TEST-STRATEGY.md` §7 关联的 nightly coverage 与分片后 CI 墙钟基线，确认这些简化的测试收益仍然成立（分片已消化一部分文件级开销）。

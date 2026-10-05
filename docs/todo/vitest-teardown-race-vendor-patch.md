# vitest 拆卸竞态假红 —— 供应商补丁（待上游修复后退役）

**状态**：已修复（2026-10-03，供应商补丁 `patches/vitest.patch` 入库）；**未决** = 上游修复后退役补丁。

## 症状

全仓 `pnpm test` 间歇出现「**全绿 + exit 1**」：每个包 Test Files / Tests 全 passed，机器判读却拿到非零退出码。2026-10-03 实测约 12%／轮（20 轮验证期间命中多次），归属文件每轮漂移（`record-store-cache.test.ts`、其他文件轮转），排查时极易误判为「某用例坏了」。

## 根因

上游 vitest 缺陷（[vitest#11153](https://github.com/vitest-dev/vitest/issues/11153)）：全部测试文件跑完后，池 worker 自身拆卸机器（birpc `$rejectPendingCalls` 的 `EnvironmentTeardownError`、pool-runner rpc `$close` 竞争、stopped 应答竞争）抛出迟到 rejection；该错误经 `VITEST_TEST_PATH` 归属到 worker 当时所在的文件，落入 `state.errors`，导致 `_checkUnhandledErrors` 置 `exitCode = 1`。**与用户代码无关**。

## 修法（本仓）

`patches/vitest.patch`（pnpm 供应商补丁，登记在 `pnpm-workspace.yaml` 的 `patchedDependencies`——pnpm 10 忽略 package.json 的 `pnpm` 字段，写那里会被下次 install 洗掉）。补丁在 `_checkUnhandledErrors` 加防卫门，**两个条件同时成立才抑制**：

1. 本轮**全绿**（`getCountOfFailedTests() === 0` 且无失败文件）
2. 每条错误**逐条命中拆卸竞态签名**：`EnvironmentTeardownError` / `[vitest-worker]:` 前缀 / `[vitest-pool-runner]: Pending methods while closing rpc`

签名集**刻意排除**会掩盖真失败的形状：`[vitest-pool]: Worker ... emitted error`、`Worker exited unexpectedly`（worker 运行中崩溃可静默丢文件）、`EPIPE` / `ERR_IPC_CHANNEL_CLOSED`（可能是用户测试卫生问题）、`Unhandled Error` / `Test Run Error` 类型。正常路径行为与上游逐字节一致（真失败、绿跑上用户代码的 unhandled error 照常失败）。

两条日志通道自证：命中抑制打 `[taiji-vitest-patch] suppressed N teardown-race unhandled error(s)`；绿跑但**未匹配**签名打 `... did NOT match teardown-race signatures — keeping upstream failure; ARCHIVE THIS LINE as race evidence`（保留失败并要求归档证据行）。逃生阀 `VITEST_TAIJI_RELAX_GREEN_UNHANDLED=1` 放宽签名（仅排障用）。

## 退役条件

上游发布修复后：**移除补丁 → 全仓 20 轮探针复验**（脚本模板见本次验证，产物曾落 `.tmp/vitest-patch-verify/`）→ 零假红才删除 `patches/vitest.patch` 与 `pnpm-workspace.yaml` 登记。补丁用**裸键** `vitest:`（不带版本）登记：vitest 升级导致补丁打不上即 install 报错——这是刻意选的**响亮失败**（若用版本钉死键，升级后会静默跳过补丁、假红复现而无人察觉）。

## 验证证据（2026-10-03）

- 全仓 20 轮验证：**7 连 GREEN**，其中第 1 轮补丁正向命中（`suppressed=1`，exit 0）——被吞错误的签名与归属（`EnvironmentTeardownError` + `onUserConsoleLog` + subagent-core）与无补丁时的假红实况完全一致
- 补丁逻辑四象限单测 15/15（从已打补丁的产物中抠出真函数体，受控 stub 驱动）：真失败不吞 / 空错误集不吞 / 未匹配错误不吞且留证据 / 命中签名才吞
- **反向确认**：第 08 轮全仓并发出现真实失败（`remote-engine.test.ts` 15s 超时）时补丁**没有**吞（`suppressed=0`）；该文件单独复跑 31/31 通过（7.7s）→ 属 46 包并发的负载型超时，非回归
- 同批修掉一个测试卫生挡路石：`AsyncErrorFallback.test.ts` 的 `void retry.loader()` 泄漏 unhandled rejection（稳定制造 exit 1，会淹没补丁验证）→ 改为显式 `.catch()`

## 关联

- 测试策略登记与 flake 规范：[docs/TEST-STRATEGY.md](../TEST-STRATEGY.md)
- 补丁文件头注释含同样的退役条件与升级触发说明

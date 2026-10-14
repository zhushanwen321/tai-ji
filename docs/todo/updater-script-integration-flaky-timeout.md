# updater-script-integration S1 用例负载下瞬态超时

状态：开放（瞬态 flake，单文件复跑稳定绿；不阻塞合并，本次以复跑通过闭环）。

## 现象

`apps/electron/main/test/updater-script-integration.test.ts` 的「S1 中断（M2 脚本侧）：staging 解压完成后 kill」用例在全量并发跑（`pnpm test`，43 包并行）中偶发 `waitFor 超时: staging 主二进制就位`（22s 预算耗尽）；同文件单独复跑 23 用例全绿。该文件与其被测源码在引入 flake 的发布轮中零改动，属 CPU 负载敏感的时序预算问题，非回归。

## 恢复

单文件复跑确认绿后重跑全量门禁（与 coverage-gate 的 `TAIJI_COVERAGE_GATE_SERIAL=1` 串行复跑同思路）。

## 修复方向

按该用例的 waitFor 目标校准预算（当前 22s 在满载下不裕），或给该文件标注高负载下的串行/降载执行形态；修前先采集全量并发时的实际就位耗时分布，避免盲目放大预算掩盖真实退化。

# branch-review minor 残余（dev-merge 前置审查随分支带走项）

> **状态**：低优先级待裁决（不阻塞合并，随分支合入 dev-0.10.13）。**来源**：2026-10-05 dev-merge-gates branch-review 第 2 轮收敛后的 minor 残余（`.tmp/dev-merge-review/dmg-6d8e8c66c/`，终态 converged，4 major 已修复）。逐条修复时按各自 files 定位。

## 1. artifact-retention 枚举失败窗口的活会话保护失效面

`packages/runtime/src/services/session/artifact-retention.ts`——三树枚举的 readdir 失败按「无会话文件」处理，活会话保护判据②（目录名在会话树无同名会话文件 → 可清）在枚举失败窗口失效，可能误清仍活会话的产物目录。修复方向：readdir 失败时保守取向「视为存在、不清」并出声（对齐解析失配的保守取向）。

## 2. 三树枚举承重负断言缺持久源码锚点

`packages/runtime/src/services/session/artifact-retention.ts`——头注「三棵树即全部会话文件写面」的唯一证据是不入库的 P-3 探针（`.tmp` 探针随 worktree 生命周期消失）。修复方向：把枚举完备性断言固化为可重跑的持久检查（脚本或单测锚点）。

## 3. 产物目录公式对拍机检未覆盖 runtime 侧 sessionId 正则

`scripts/check-artifact-dir-formula-sync.mjs`——sessionId 正则只对拍 shared ↔ extension 两处，runtime `PI_SESSION_ID_PATTERN` 漂移时检查不红。修复方向：把 runtime 正则字面量纳入对拍集合。

## 4. POSIX resolve 对拍守卫低于同批守卫交付标准

`scripts/check-posix-resolve-mirror-sync.mjs`（dev-merge 审查修复新增，commit `630e7738f`）——缺回归测试（对照 `check-capability-allowlist-sync.test.mjs` 先例）与 CI 挂载，`--self-test` 无自动化挂载点。修复方向：补 `scripts/__tests__/check-posix-resolve-mirror-sync.test.mjs` + CI invariants 挂载。

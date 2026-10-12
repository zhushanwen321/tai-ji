# dev-merge branch-review R2 minor 残余（3 条，随分支带走）

状态：开放（minor 档，不阻塞合并；终局 PR 期复核）。来源：dev-merge branch-review run dmg-854627eee 第 2 轮收敛后的 open 清单（报告 .tmp/dev-merge-review/dmg-854627eee/round-2/）。

## 残余清单

1. **跨进程布局契约两处并存，仅注释同步无机器对拍**：`packages/shared/src/paths.ts` 的 PI_SESSION_TREE_SEGMENTS 与 `packages/runtime/src/infra/pi/pi-paths.ts` 的树段字面量两处并存，43f27f789 上提常量后仅注释互指。修复方向 = 纳入 `scripts/check-artifact-dir-formula-sync.mjs` 同族对拍（读双侧源文本逐字比对）或在 e2e-map 登记 rule；触发面清单见 `docs/testing/e2e-map.json` E2E-ARTDIR-01 note。
2. **data-source-registry.md zcode 同步副本行 4 处 file:line 指针漂移**：c14ac7739 把 zcode synced provider config path segments 收编 SDK SSOT 后，`docs/architecture/data-source-registry.md` 中该行的常量定位与同行 file:line 指针未同步（grep zcode 同步副本行核对现行行号）。
3. **session-readers-census.md §2 R2 锚点计数漂移**：`docs/architecture/session-readers-census.md` §2 的「39+1 文件」计数与实测命中 42 文件不符（登记表本身已闭合，仅锚点注释数字陈旧）。

# e2e 真实进程层 spec 盲等形态待治理（盲等检查范围外）

状态：未解决（2026-10-20 登记；盲等机器检查已落地并显式排除本域，治理待排期）

## 现状

- 仓根 `e2e/*.spec.ts`（Playwright 真机 真实进程层）现存 11 处固定时长盲等（`await new Promise((r) => setTimeout(r, 500|1000|2500))` 后断言 UI 渲染/状态），分布在 ask-user-real / tasks-drawer-real / workflow-disconnect-recovery / workflow-thinkinglevel-real / workspace-real 五个文件。
- 2026-10-20 落地的盲等形态检查 `.githooks/check-test-blind-wait.mjs` 显式排除 `e2e/` 前缀（Playwright 真实进程层域：串行空载跑、非 CI 门禁线，与 vitest 单测线的并发压力形态不同），因此这 11 处不触发检查——排除是范围决策，不是判定它们合法。

## 待办

- 逐处改条件等待：Playwright 侧用 `expect(locator).toBeVisible({ timeout })` / `page.waitForURL` 等自带轮询的断言替换 sleep 后断言；负向断言用分片采样保持观察窗。
- 治理时机：e2e 真实进程层按改动范围跑（AGENTS.md e2e 执行准则），改哪条 spec 就在真实环境验证哪条；无真实环境窗口时不动，避免「改了没跑过」的假修复。

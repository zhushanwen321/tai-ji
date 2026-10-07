# 移动壳 token 镜像的 e2e-map scope 缺口（packages/mobile-renderer/** 无 rule 覆盖）

状态：已解决（2026-10-06 定案）——scope 登记与镜像一致性单测均已落地：`docs/testing/e2e-map.json` 的 E2E-VISUAL-01 增补 `packages/mobile-renderer/src/styles/**` scope；`packages/renderer/src/__tests__/mobile-token-mirror-parity.test.ts` 机器断言两文件 accent 令牌族逐字一致（断言面四组：玄块主三值 / color-mix 派生式 / shadcn 两行引用 / desktop 定稿锚定，非全文件）。登记来源：ui-signal-density 设计 D3 移动壳镜像条 + §4.2（v7 登记，v8 补触发条件）

## 缺口（背景）

`docs/testing/e2e-map.json` 全部 62 条 rule 的 scope 此前无一条覆盖 `packages/mobile-renderer/**`（设计期已 read 全量 scope 核实）。该目录下的 `styles/tokens.css` 是 renderer `style.css` tokens 段的**镜像副本**（文件头注释自述「真值源仍是 renderer style.css（SSOT: docs/DESIGN.md §4）……改动须同步两处」），只改桌面侧时移动壳静默漂移不会触发任何 e2e。

## 定案登记（触发条件：任一 accent 令牌族改动落地时）

- **触发与兑现**：accent 令牌族改动（renderer `style.css` 与移动壳 `tokens.css` 双侧 `:root` 玄块三值）落地，scope 登记随同批完成，无无记录跳过。
- **scope 归属裁决**：E2E-VISUAL-01（像素 diff 轨）——令牌镜像值变更与桌面令牌同属视觉触发面（accent 变更触发基线重录，见该 rule note 的 2026-10-06 D3 段），行为轨（E2E-MOCK-01 / E2E-ELECTRON-01）不承载令牌值变更。
- **登记范围** = `packages/mobile-renderer/src/styles/**`（镜像宿主目录，进 `--check` 门禁 watched roots）；`packages/mobile-renderer/**` 其余子目录不在本缺口射程（设计 D3 只触及令牌镜像宿主，移动壳其余 UI 的 e2e 覆盖另议）。
- **机器兜底**：`packages/renderer/src/__tests__/mobile-token-mirror-parity.test.ts`（断言面 = 两文件 `:root` 玄块三值 + 派生式逐字相等）。

## 兜底现状

镜像一致性由 `mobile-token-mirror-parity.test.ts`（镜像一致性单测，断言面 = accent 令牌族四组）机器断言 + E2E-VISUAL-01 scope 覆盖镜像宿主目录；改桌面 accent 令牌族不同步移动壳会被单测拦截，族外令牌仍靠 E2E-VISUAL-01 像素轨兜底。

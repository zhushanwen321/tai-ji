# 移动壳 token 镜像的 e2e-map scope 缺口（packages/mobile-renderer/** 无 rule 覆盖）

状态：缺口已登记、修复待 U9 同 commit 完成（兜底 = `mobile-token-mirror-parity.test.ts` 镜像一致性单测，随令牌镜像改动落地）。登记来源：ui-signal-density 设计 D3 移动壳镜像条 + §4.2（v7 登记，v8 补触发条件）

## 缺口

`docs/testing/e2e-map.json` 全部 62 条 rule 的 scope 无一条覆盖 `packages/mobile-renderer/**`（设计期已 read 全量 scope 核实）。该目录下的 `styles/tokens.css` 是 renderer `style.css` tokens 段的**镜像副本**（文件头注释自述「真值源仍是 renderer style.css（SSOT: docs/DESIGN.md §4）……改动须同步两处」），只改桌面侧时移动壳静默漂移不会触发任何 e2e。

## 修复动作（触发条件：任一 accent 令牌族改动落地时）

给 e2e-map 增补覆盖 `packages/mobile-renderer/**` 的 scope 登记（归属承载该镜像消费面的 rule），或显式记「本次不适用 + 理由」——不许无记录跳过。

- **ui-redesign-combined 文档回写批（本登记批次）不适用**：本批只改 `docs/` 文档，不改 `packages/mobile-renderer/` 任何文件，无新增触发面。
- scope 登记与 `packages/renderer/src/__tests__/mobile-token-mirror-parity.test.ts`（把「人读对读」升级为机器断言：两文件 `:root` 玄块三值 + 派生式逐字相等）随令牌镜像值改动同 commit 落地，由该单元（U9）承接。

## 兜底现状

镜像同步目前只有 `tokens.css` 文件头注释一处口头约束、没有双侧机器检查。镜像一致性单测落地前，改桌面令牌须人工同步检查移动壳镜像。

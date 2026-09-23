// src/__tests__/wire-field-locks.test.ts
//
// U3 双写禁令（engine-protocol-extensibility 实施计划 §2 U3 行；设计 §5 U3 + 附录 A 判据 4）。
//
// 判据 4（绝对条款）：同一语义不得 task/ctx 双写——wire 层同名键交集恒空。
// 断言 = `keyof AgentCallOpts & keyof RunContextParams = never` 的 type-level 编译锁
//（测试文件内类型断言经 `pnpm --filter @zhushanwen/subagent-engine-sdk typecheck`
//  的 tsc --noEmit 覆盖；红绿对演练 = 两侧临时加同名探针键 → 编译红且
//  错误指向本文件断言行 → 撤除后回绿，演练不落盘）。
//
// schemaEnv 现状（豁免登记；两种形态择一，现状如实取「纯 never」形态）：
//   - wire 层键集交集现状**为空**——SDK AgentCallOpts（run.params.task）已按字段裁决
//     排除 schemaEnv（contract-types.ts 字段裁决注释：「schemaEnv（→ctx.schemaEnv）」），
//     schemaEnv 只在 RunContextParams（run.params.ctx）单侧存在 → 无需 Exclude<> 豁免。
//   - 但 H1b **未收口**（P5 已销案为「在飞」）：宿主派发面仍双源合流
//     `ctx.schemaEnv ?? task.schemaEnv`，锚点
//     `packages/subagent-core/src/execution/engine/client/remote-engine.ts:382`
//     （该处 task = core 全量 AgentCallOpts，含 schemaEnv，见
//      packages/subagent-core/src/orchestration/models/types.ts；双源在 core→wire 投影
//      过程中，不体现为 wire 键集交集）。
//   - H1b 收口（remote-engine.ts:382 双源消灭）后本断言无需摘除：断言只钉 wire 键集，
//     收口后恒绿；届时仅需回看本注释是否过期。

import { describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../protocol/contract-types.ts";
import type { RunContextParams } from "../protocol/methods.ts";

/** wire 层 task/ctx 键集交集：判据 4 要求恒 never（同名键 = 同一语义双写违宪）。 */
type WireTaskCtxKeyIntersection = keyof AgentCallOpts & keyof RunContextParams;

// 编译锁：交集一旦非 never，下方三元求值为 never，`const _assert… = true` 赋值处
// 编译红（错误位置 = 本断言行，即演练要指向的点）。
const _assertNoDoubleWrite: WireTaskCtxKeyIntersection extends never ? true : never = true;

describe("U3 双写禁令（wire 层 task/ctx 同名键交集恒空）", () => {
  it("keyof AgentCallOpts & keyof RunContextParams = never（type-level 编译锁 + 运行时形态可执行确认）", () => {
    expect(_assertNoDoubleWrite).toBe(true);
  });
});

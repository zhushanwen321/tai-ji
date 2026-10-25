/**
 * SubagentModelSource 双侧值域对拍单测（dev-0.11.4 审查残余 S-9 的机器检查）。
 *
 * 副本对（core 不依赖 @taiji/shared——类型副本双侧各持一份，workflow-dag-parser
 * 同款边界）：
 * - shared：packages/shared/src/subagent.ts 的 SubagentModelSource +
 *   SUBAGENT_MODEL_SOURCE_ALL（值全集元组）；
 * - core（本包）：src/execution/domain/record-model.ts 的 SubagentModelSource +
 *   SUBAGENT_MODEL_SOURCES（值全集元组）。
 *
 * 两层判据（任一侧增删/改值即红）：
 * 1. 编译期：双向类型兼容断言（core ⊆ shared 且 shared ⊆ core = 字面量联合等值）
 *    ——本包 typecheck（tsc --noEmit）时生效；
 * 2. 运行时：双侧运行时清单逐项比对——类型联合无运行时表示，运行时判据锚在双侧
 *    元组上；vitest run 即红（顺序无关比对，长度/成员差异均翻红）。
 *
 * 运行：cd packages/subagent-core && npx vitest run src/execution/__tests__/subagent-model-source-parity.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { SubagentModelSource as SharedSubagentModelSource } from '@taiji/shared'
import { SUBAGENT_MODEL_SOURCE_ALL } from '@taiji/shared'
import type { SubagentModelSource as CoreSubagentModelSource } from '../domain/record-model'
import { SUBAGENT_MODEL_SOURCES } from '../domain/record-model'

// ── 编译期断言：双向兼容（删任一侧字面量 → 某方向赋值 tsc 红）──────────────────
type Assignable<T, U> = [T] extends [U]
  ? true
  : ['SubagentModelSource 双侧值域漂移：一侧字面量不在另一侧联合内（S-9 对拍断言失败）']

const _coreToShared: Assignable<CoreSubagentModelSource, SharedSubagentModelSource> = true
const _sharedToCore: Assignable<SharedSubagentModelSource, CoreSubagentModelSource> = true
// 消费以通过 noUnusedLocals（类型断言无运行时语义，值恒 true）
void _coreToShared
void _sharedToCore

describe('SubagentModelSource 双侧值域对拍（S-9：shared 副本 ↔ core 本地副本）', () => {
  it('运行时清单逐项相等（顺序无关）：SUBAGENT_MODEL_SOURCES ≡ SUBAGENT_MODEL_SOURCE_ALL', () => {
    // toEqual 对长度与成员逐位敏感：任一侧增删值 / 单侧内部重复（元组 satisfies
    // 正向锁不拦重复）均使比对失败
    expect([...SUBAGENT_MODEL_SOURCES].sort()).toEqual([...SUBAGENT_MODEL_SOURCE_ALL].sort())
  })

  it('双侧清单非空且成员无重复（元组作为值域锚点的形态前提）', () => {
    const coreValues = [...SUBAGENT_MODEL_SOURCES]
    const sharedValues = [...SUBAGENT_MODEL_SOURCE_ALL]
    expect(coreValues.length).toBeGreaterThan(0)
    expect(sharedValues.length).toBeGreaterThan(0)
    expect(new Set(coreValues).size).toBe(coreValues.length)
    expect(new Set(sharedValues).size).toBe(sharedValues.length)
  })
})

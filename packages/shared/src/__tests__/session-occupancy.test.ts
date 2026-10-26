/**
 * session-occupancy.test.ts — chat-flow-consistency D1 契约根单测（u-foundation 单元）
 *
 * 「回合进行中」判定集合 ACTIVE_TURN_PHASES 逐值断言：期望值 = 设计 §3.3 D1 定稿集合
 * {dispatching, generating, settling}（settling 纳入 steer 排队的单点生效源，设计采用 2）。
 * 模式与 protocol-occupancy.test.ts 一致：编译期 AssertExtends 类型断言（tsc --noEmit
 * 保证）+ 运行期逐值断言（vitest）。纯类型与常量层，零运行时依赖。
 *
 * 运行：cd packages/shared && pnpm vitest run
 */
import { describe, it, expect } from 'vitest'
import { ACTIVE_TURN_PHASES, isActiveTurnPhase } from '../session-occupancy'
import type { ActiveTurnPhase, SessionTurnPhase } from '../session-occupancy'
import type { ServerMessageMap } from '../protocol'

// ── 编译期类型断言辅助（同 protocol-occupancy.test.ts 模式）────────────────
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]

// 编译期：判定集合成员 ⊆ turn 相位值域（集合与 wire 类型同源的构造性约束）
type _Assert_MembersInTurnPhase = AssertExtends<ActiveTurnPhase, SessionTurnPhase>

// 编译期：'idle' 不在判定集合（回合进行中判定不含空档相位）
type _Assert_IdleNotMember = AssertExtends<ActiveTurnPhase, Exclude<SessionTurnPhase, 'idle'>>

// 编译期：wire 帧 turn 字段值域 = SessionTurnPhase（协议内联引用与形状 SSOT 未漂移）
type _Assert_WireTurnPhase = AssertExtends<
  ServerMessageMap['session.occupancy']['turn'],
  SessionTurnPhase
>

describe('ACTIVE_TURN_PHASES「回合进行中」判定集合（chat-flow-consistency D1）', () => {
  it('逐值 = 设计定稿集合 {dispatching, generating, settling}', () => {
    expect([...ACTIVE_TURN_PHASES]).toEqual(['dispatching', 'generating', 'settling'])
  })

  it('每个设计定稿相位都在集内', () => {
    expect(ACTIVE_TURN_PHASES).toContain('dispatching')
    expect(ACTIVE_TURN_PHASES).toContain('generating')
    expect(ACTIVE_TURN_PHASES).toContain('settling')
  })

  it('idle 不在集内（回合进行中判定不含空档相位）', () => {
    expect(ACTIVE_TURN_PHASES).not.toContain('idle')
  })
})

describe('isActiveTurnPhase 判定函数（ACTIVE_TURN_PHASES 的唯一函数读口）', () => {
  it('集内相位 → true，集外（idle）→ false', () => {
    expect(isActiveTurnPhase('dispatching')).toBe(true)
    expect(isActiveTurnPhase('generating')).toBe(true)
    expect(isActiveTurnPhase('settling')).toBe(true)
    expect(isActiveTurnPhase('idle')).toBe(false)
  })
})
